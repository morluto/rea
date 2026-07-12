import { DirectedGraph } from "graphology";
import { bidirectional } from "graphology-shortest-path/unweighted.js";
import { z } from "zod";

import { evidenceSchema } from "./evidence.js";
import {
  parseFunctionEvidence,
  type FunctionSnapshot,
} from "./functionDossierEvidence.js";

const addressSchema = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/u);
const inputAddressSchema = z
  .string()
  .regex(/^0[xX][0-9a-fA-F]+$/u)
  .transform((address) => `0x${BigInt(address).toString(16)}`);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const evidenceGroupSchema = z.union([
  evidenceSchema,
  z.array(evidenceSchema).min(1).max(100),
]);
const MAX_EVIDENCE_PAGES = 2_000;
const MAX_GRAPH_EDGES = 10_000;
const MAX_PATH_EXPANSIONS = 100_000;

/** Strict, bounded input for explicit call-path reconstruction. */
export const callPathInputSchema = z
  .object({
    functions: z.array(evidenceGroupSchema).min(1).max(500),
    start: z.object({ address: inputAddressSchema }).strict(),
    goal: z.object({ address: inputAddressSchema }).strict(),
    max_depth: z.number().int().min(0).max(32).default(8),
    max_paths: z.number().int().min(1).max(100).default(10),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(100),
    unknown_registry_approved: z.literal(true).optional(),
  })
  .superRefine(({ functions }, context) => {
    const pages = functions.reduce(
      (total, group) => total + (Array.isArray(group) ? group.length : 1),
      0,
    );
    if (pages > MAX_EVIDENCE_PAGES)
      context.addIssue({
        code: "custom",
        message: `Call-path Evidence exceeds ${MAX_EVIDENCE_PAGES} pages`,
        path: ["functions"],
      });
  });

const citedNodeSchema = z.object({
  address: addressSchema,
  name: z.string().nullable(),
  evidence_links: z.array(evidenceIdSchema).min(1).max(100),
});
const citedEdgeSchema = z.object({
  source: addressSchema,
  target: addressSchema,
  evidence_links: z.array(evidenceIdSchema).min(1).max(100),
});
const pathSchema = z.object({
  hops: z.number().int().min(0),
  nodes: z.array(citedNodeSchema).min(1).max(33),
  edges: z.array(citedEdgeSchema).max(32),
  evidence_links: z.array(evidenceIdSchema).min(1).max(3_300),
});

/** Evidence-cited, bounded directed call-path result. */
export const callPathResultSchema = z.object({
  status: z.enum(["found", "not_found", "unknown", "truncated"]),
  start: addressSchema,
  goal: addressSchema,
  shortest_hops: z.number().int().min(0).nullable(),
  search_scope: z.object({
    max_depth: z.number().int().min(0).max(32),
    max_paths: z.number().int().min(1).max(100),
    exhaustive: z.boolean(),
  }),
  explored: z.object({
    nodes: z.number().int().min(0),
    edges: z.number().int().min(0),
    depth_reached: z.number().int().min(0),
  }),
  paths: z.object({
    items: z.array(pathSchema).max(100),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().min(0).nullable(),
    returned: z.number().int().min(0).max(100),
    truncated: z.boolean(),
    lower_bound: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
  }),
  evidence_links: z.array(evidenceIdSchema).min(1).max(50_000),
  limitations: z.array(z.string()),
});

export type CallPathInput = z.infer<typeof callPathInputSchema>;
export type CallPathResult = z.infer<typeof callPathResultSchema>;
type OutputPath = z.infer<typeof pathSchema>;

interface SearchState {
  readonly graph: DirectedGraph;
  readonly snapshots: ReadonlyMap<string, FunctionSnapshot>;
  readonly reached: ReadonlyMap<string, number>;
  readonly exhaustive: boolean;
  readonly limitations: readonly string[];
}

/** Reconstruct bounded direct-callee paths from explicit analyze_function Evidence. */
export const buildCallPath = (input: CallPathInput): CallPathResult => {
  const parsed = callPathInputSchema.parse(input);
  const snapshots = parseSnapshots(parsed.functions);
  assertCompatible(snapshots);
  if (!snapshots.has(parsed.start.address))
    throw new TypeError(
      `No analyze_function Evidence was supplied for start ${parsed.start.address}`,
    );
  const graph = createGraph(snapshots);
  const search = inspectSearch({
    graph,
    snapshots,
    start: parsed.start.address,
    goal: parsed.goal.address,
    maxDepth: parsed.max_depth,
  });
  const shortest =
    graph.hasNode(parsed.start.address) && graph.hasNode(parsed.goal.address)
      ? bidirectional(graph, parsed.start.address, parsed.goal.address)
      : null;
  const enumeration =
    shortest === null || shortest.length - 1 > parsed.max_depth
      ? { paths: [], budgetExhausted: false }
      : enumeratePaths({
          graph,
          start: parsed.start.address,
          goal: parsed.goal.address,
          shortestDepth: shortest.length - 1,
          maxDepth: parsed.max_depth,
          limit: parsed.max_paths + 1,
        });
  const hasKnownExtraPath = enumeration.paths.length > parsed.max_paths;
  const capped = hasKnownExtraPath || enumeration.budgetExhausted;
  const retained = enumeration.paths.slice(0, parsed.max_paths);
  const paths = retained.map((path) => citePath(path, snapshots));
  const total = paths.length;
  const items = paths.slice(parsed.offset, parsed.offset + parsed.limit);
  const found = paths.length > 0;
  const exhaustive = search.exhaustive && !capped;
  const status = callPathStatus({ capped, found, exhaustive });
  const limitations = [...search.limitations];
  if (capped)
    limitations.push(
      enumeration.budgetExhausted
        ? `Path enumeration stopped at ${MAX_PATH_EXPANSIONS} expansions`
        : `Path enumeration stopped at max_paths=${parsed.max_paths}`,
    );
  if (!found && shortest !== null && shortest.length - 1 > parsed.max_depth)
    limitations.push(
      `The shortest observed path exceeds max_depth=${parsed.max_depth}`,
    );
  return callPathResultSchema.parse({
    status,
    start: parsed.start.address,
    goal: parsed.goal.address,
    shortest_hops: found ? (paths[0]?.hops ?? null) : null,
    search_scope: {
      max_depth: parsed.max_depth,
      max_paths: parsed.max_paths,
      exhaustive,
    },
    explored: {
      nodes: search.reached.size,
      edges: [...search.reached.keys()].reduce(
        (count, node) =>
          count + (graph.hasNode(node) ? graph.outDegree(node) : 0),
        0,
      ),
      depth_reached: Math.max(0, ...search.reached.values()),
    },
    paths: {
      items,
      offset: parsed.offset,
      limit: parsed.limit,
      total: capped ? null : total,
      returned: items.length,
      truncated: capped,
      lower_bound: total + (hasKnownExtraPath ? 1 : 0),
      next_offset:
        parsed.offset + items.length < total
          ? parsed.offset + items.length
          : null,
    },
    evidence_links: uniqueEvidence(snapshots.values()),
    limitations: [...new Set(limitations)].sort((left, right) =>
      left.localeCompare(right),
    ),
  });
};

const callPathStatus = ({
  capped,
  found,
  exhaustive,
}: {
  readonly capped: boolean;
  readonly found: boolean;
  readonly exhaustive: boolean;
}): CallPathResult["status"] => {
  if (capped) return "truncated";
  if (found) return "found";
  return exhaustive ? "not_found" : "unknown";
};

const parseSnapshots = (
  groups: readonly z.infer<typeof evidenceGroupSchema>[],
): Map<string, FunctionSnapshot> => {
  const snapshots = new Map<string, FunctionSnapshot>();
  for (const group of groups) {
    const snapshot = parseFunctionEvidence(group);
    const address = normalizeAddress(snapshot.procedure.address);
    for (const callee of snapshot.collections.callees.items)
      normalizeAddress(callee.address);
    if (snapshots.has(address))
      throw new TypeError(`Duplicate function Evidence for ${address}`);
    snapshots.set(address, snapshot);
  }
  return snapshots;
};

const assertCompatible = (
  snapshots: ReadonlyMap<string, FunctionSnapshot>,
): void => {
  const first = snapshots.values().next().value as FunctionSnapshot | undefined;
  if (first === undefined) return;
  for (const snapshot of snapshots.values()) {
    if (
      snapshot.subject.digest.sha256 !== first.subject.digest.sha256 ||
      snapshot.subject.format !== first.subject.format ||
      snapshot.subject.architecture !== first.subject.architecture
    )
      throw new TypeError("Call-path Evidence mixes artifact subjects");
    if (
      snapshot.provider.id !== first.provider.id ||
      snapshot.provider.name !== first.provider.name ||
      snapshot.provider.version !== first.provider.version
    )
      throw new TypeError("Call-path Evidence mixes providers");
  }
};

const createGraph = (
  snapshots: ReadonlyMap<string, FunctionSnapshot>,
): DirectedGraph => {
  const graph = new DirectedGraph({ allowSelfLoops: true, multi: false });
  for (const [address, snapshot] of snapshots) {
    graph.mergeNode(address);
    for (const callee of snapshot.collections.callees.items) {
      const calleeAddress = normalizeAddress(callee.address);
      graph.mergeNode(calleeAddress);
      graph.mergeDirectedEdge(address, calleeAddress);
      if (graph.size > MAX_GRAPH_EDGES)
        throw new TypeError(
          `Call graph exceeds ${MAX_GRAPH_EDGES} directed edges`,
        );
    }
  }
  return graph;
};

interface SearchInput {
  readonly graph: DirectedGraph;
  readonly snapshots: ReadonlyMap<string, FunctionSnapshot>;
  readonly start: string;
  readonly goal: string;
  readonly maxDepth: number;
}

const inspectSearch = ({
  graph,
  snapshots,
  start,
  goal,
  maxDepth,
}: SearchInput): SearchState => {
  if (!graph.hasNode(start))
    return {
      graph,
      snapshots,
      reached: new Map(),
      exhaustive: false,
      limitations: [
        `No analyze_function Evidence was supplied for start ${start}`,
      ],
    };
  const reached = new Map<string, number>([[start, 0]]);
  const queue = [start];
  const limitations: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    if (node === undefined) continue;
    const depth = reached.get(node) ?? 0;
    if (node === goal) continue;
    const snapshot = snapshots.get(node);
    if (snapshot === undefined) {
      limitations.push(
        `No analyze_function Evidence covers reachable function ${node}`,
      );
      continue;
    }
    if (!snapshot.collections.callees.complete)
      limitations.push(
        `Callee coverage is incomplete for reachable function ${node}`,
      );
    const neighbors = graph
      .outNeighbors(node)
      .sort((left, right) => left.localeCompare(right));
    if (depth === maxDepth) {
      if (neighbors.length > 0)
        limitations.push(`Search reached max_depth=${maxDepth} at ${node}`);
      continue;
    }
    for (const neighbor of neighbors)
      if (!reached.has(neighbor)) {
        reached.set(neighbor, depth + 1);
        queue.push(neighbor);
      }
  }
  return {
    graph,
    snapshots,
    reached,
    exhaustive: limitations.length === 0,
    limitations,
  };
};

interface EnumerationInput {
  readonly graph: DirectedGraph;
  readonly start: string;
  readonly goal: string;
  readonly shortestDepth: number;
  readonly maxDepth: number;
  readonly limit: number;
}

const enumeratePaths = ({
  graph,
  start,
  goal,
  shortestDepth,
  maxDepth,
  limit,
}: EnumerationInput): {
  readonly paths: string[][];
  readonly budgetExhausted: boolean;
} => {
  const output: string[][] = [];
  const state: EnumerationState = {
    graph,
    goal,
    path: [start],
    visited: new Set([start]),
    output,
    limit,
    expansions: 0,
    budgetExhausted: false,
  };
  for (
    let depth = shortestDepth;
    depth <= maxDepth && output.length < limit;
    depth += 1
  )
    enumerateAtDepth(state, depth);
  return { paths: output, budgetExhausted: state.budgetExhausted };
};

interface EnumerationState {
  readonly graph: DirectedGraph;
  readonly goal: string;
  readonly path: string[];
  readonly visited: Set<string>;
  readonly output: string[][];
  readonly limit: number;
  expansions: number;
  budgetExhausted: boolean;
}

const enumerateAtDepth = (state: EnumerationState, remaining: number): void => {
  const { graph, goal, path, visited, output, limit } = state;
  state.expansions += 1;
  if (state.expansions > MAX_PATH_EXPANSIONS) {
    state.budgetExhausted = true;
    return;
  }
  const current = path.at(-1);
  if (current === undefined || output.length >= limit) return;
  if (remaining === 0) {
    if (current === goal) output.push([...path]);
    return;
  }
  if (current === goal) return;
  for (const neighbor of graph
    .outNeighbors(current)
    .sort((left, right) => left.localeCompare(right))) {
    if (visited.has(neighbor)) continue;
    visited.add(neighbor);
    path.push(neighbor);
    enumerateAtDepth(state, remaining - 1);
    path.pop();
    visited.delete(neighbor);
    if (output.length >= limit || state.budgetExhausted) return;
  }
};

const citePath = (
  addresses: readonly string[],
  snapshots: ReadonlyMap<string, FunctionSnapshot>,
): OutputPath => {
  const edges = addresses.slice(0, -1).map((source, index) => {
    const target = addresses[index + 1];
    if (target === undefined)
      throw new TypeError("Call path has an invalid edge");
    return {
      source,
      target,
      evidence_links: snapshotLinks(snapshots.get(source)),
    };
  });
  const nodes = addresses.map((address, index) => {
    const snapshot = snapshots.get(address);
    const supporting =
      snapshot ??
      (index > 0 ? snapshots.get(addresses[index - 1] ?? "") : undefined);
    return {
      address,
      name: snapshot?.procedure.name ?? null,
      evidence_links: snapshotLinks(supporting),
    };
  });
  return {
    hops: edges.length,
    nodes,
    edges,
    evidence_links: [
      ...new Set(
        edges
          .flatMap(({ evidence_links: links }) => links)
          .concat(nodes.flatMap(({ evidence_links: links }) => links)),
      ),
    ],
  };
};

const snapshotLinks = (snapshot: FunctionSnapshot | undefined): string[] => {
  if (snapshot === undefined)
    throw new TypeError("Every call-path claim requires supporting Evidence");
  return snapshot.evidence.map(({ evidence_id }) => evidence_id);
};

const uniqueEvidence = (snapshots: Iterable<FunctionSnapshot>): string[] =>
  [
    ...new Set([...snapshots].flatMap((snapshot) => snapshotLinks(snapshot))),
  ].sort((left, right) => left.localeCompare(right));

const normalizeAddress = (input: string): string =>
  inputAddressSchema.parse(input);
