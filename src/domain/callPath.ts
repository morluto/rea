import { DirectedGraph } from "graphology";
import { bidirectional } from "graphology-shortest-path/unweighted.js";

import {
  callPathInputSchema,
  callPathResultSchema,
  parseCallPathAddress,
  type CallPathEvidenceGroup,
  type CallPathInput,
  type CallPathResult,
  type OutputCallPath,
} from "./callPathSchemas.js";
import {
  parseFunctionEvidence,
  type FunctionSnapshot,
} from "./functionDossierEvidence.js";

const MAX_GRAPH_EDGES = 10_000;
const MAX_PATH_EXPANSIONS = 100_000;

export { callPathInputSchema, callPathResultSchema };
export type { CallPathInput, CallPathResult };

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
  const { snapshots, graph } = prepareCallGraph(parsed);
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
  const shortestHops = paths[0]?.hops;
  const found = shortestHops !== undefined;
  const exhaustive = search.exhaustive && !capped;
  const limitations = deriveLimitations(
    search,
    { budgetExhausted: enumeration.budgetExhausted, capped, found, shortest },
    parsed,
  );
  const resultContext = {
    start: parsed.start.address,
    goal: parsed.goal.address,
    explored: summarizeSearch(graph, search.reached),
    evidence_links: uniqueEvidence(snapshots.values()),
    limitations: [...new Set(limitations)].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
  const searchScope = {
    max_depth: parsed.max_depth,
    max_paths: parsed.max_paths,
  };
  const pathPage = {
    items,
    offset: parsed.offset,
    limit: parsed.limit,
    returned: items.length,
    lower_bound: total + (hasKnownExtraPath ? 1 : 0),
    next_offset:
      parsed.offset + items.length < total
        ? parsed.offset + items.length
        : null,
  };
  if (capped)
    return callPathResultSchema.parse({
      ...resultContext,
      status: "truncated",
      shortest_hops: shortestHops ?? null,
      search_scope: { ...searchScope, exhaustive: false },
      paths: { ...pathPage, total: null, truncated: true },
    });
  if (found)
    return callPathResultSchema.parse({
      ...resultContext,
      status: "found",
      shortest_hops: shortestHops,
      search_scope: { ...searchScope, exhaustive },
      paths: { ...pathPage, total, truncated: false },
    });
  return callPathResultSchema.parse({
    ...resultContext,
    status: exhaustive ? "not_found" : "unknown",
    shortest_hops: null,
    search_scope: { ...searchScope, exhaustive },
    paths: {
      ...pathPage,
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
      lower_bound: 0,
      next_offset: null,
    },
  });
};

interface PathOutcome {
  readonly budgetExhausted: boolean;
  readonly capped: boolean;
  readonly found: boolean;
  readonly shortest: readonly string[] | null;
}

const deriveLimitations = (
  search: SearchState,
  outcome: PathOutcome,
  input: CallPathInput,
): string[] => {
  const limitations = [...search.limitations];
  if (outcome.capped)
    limitations.push(
      outcome.budgetExhausted
        ? `Path enumeration stopped at ${MAX_PATH_EXPANSIONS} expansions`
        : `Path enumeration stopped at max_paths=${input.max_paths}`,
    );
  if (
    !outcome.found &&
    outcome.shortest !== null &&
    outcome.shortest.length - 1 > input.max_depth
  )
    limitations.push(
      `The shortest observed path exceeds max_depth=${input.max_depth}`,
    );
  return limitations;
};

const summarizeSearch = (
  graph: DirectedGraph,
  reached: ReadonlyMap<string, number>,
) => ({
  nodes: reached.size,
  edges: [...reached.keys()].reduce(
    (count, node) => count + (graph.hasNode(node) ? graph.outDegree(node) : 0),
    0,
  ),
  depth_reached: Math.max(0, ...reached.values()),
});

const prepareCallGraph = (input: CallPathInput) => {
  const snapshots = parseSnapshots(input.functions);
  assertCompatible(snapshots);
  if (!snapshots.has(input.start.address))
    throw new TypeError(
      `No analyze_function Evidence was supplied for start ${input.start.address}`,
    );
  return { snapshots, graph: createGraph(snapshots) };
};

const parseSnapshots = (
  groups: readonly CallPathEvidenceGroup[],
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
  const firstEntry = snapshots.values().next();
  if (firstEntry.done) return;
  const first = firstEntry.value;
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
): OutputCallPath => {
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

const normalizeAddress = (input: string): string => parseCallPathAddress(input);
