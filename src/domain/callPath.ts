import {
  callPathInputSchema,
  callPathResultSchema,
  parseCallPathAddress,
  type CallPathInput,
  type CallPathResult,
  type OutputCallPath,
} from "./callPathSchemas.js";
import {
  parseFunctionEvidence,
  type FunctionSnapshot,
} from "./functionDossierEvidence.js";

export { callPathInputSchema, callPathResultSchema };
export type { CallPathInput, CallPathResult };

/** Minimal directed caller-to-callee adjacency for call-path search. */
class CallGraph {
  private readonly successors = new Map<string, Set<string>>();

  mergeNode(node: string): void {
    if (!this.successors.has(node)) this.successors.set(node, new Set());
  }

  mergeDirectedEdge(source: string, target: string): void {
    this.mergeNode(source);
    this.mergeNode(target);
    this.successors.get(source)?.add(target);
  }

  hasNode(node: string): boolean {
    return this.successors.has(node);
  }

  outDegree(node: string): number {
    return this.successors.get(node)?.size ?? 0;
  }

  outNeighbors(node: string): string[] {
    return [...(this.successors.get(node) ?? [])];
  }
}

/** Breadth-first shortest depth from start to goal, or null when unreachable. */
const shortestPathDepth = (
  graph: CallGraph,
  start: string,
  goal: string,
): number | null => {
  if (start === goal) return 0;
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index] ?? "";
    const next = (depth.get(node) ?? 0) + 1;
    for (const neighbor of graph.outNeighbors(node)) {
      if (neighbor === goal) return next;
      if (!depth.has(neighbor)) {
        depth.set(neighbor, next);
        queue.push(neighbor);
      }
    }
  }
  return null;
};

interface SearchState {
  readonly graph: CallGraph;
  readonly snapshots: ReadonlyMap<string, FunctionSnapshot>;
  readonly reached: ReadonlyMap<string, number>;
  readonly exhaustive: boolean;
  readonly limitations: readonly string[];
}

/** Reconstruct direct-callee paths from explicit analyze_function Evidence. */
export const buildCallPath = (input: CallPathInput): CallPathResult => {
  const parsed = callPathInputSchema.parse(input);
  const { snapshots, graph } = prepareCallGraph(parsed);
  const search = inspectSearch({
    graph,
    snapshots,
    start: parsed.start.address,
    goal: parsed.goal.address,
  });
  const shortestDepth =
    graph.hasNode(parsed.start.address) && graph.hasNode(parsed.goal.address)
      ? shortestPathDepth(graph, parsed.start.address, parsed.goal.address)
      : null;
  const paths =
    shortestDepth === null
      ? []
      : enumeratePaths({
          graph,
          start: parsed.start.address,
          goal: parsed.goal.address,
          shortestDepth,
        }).paths.map((path) => citePath(path, snapshots));
  const shortestHops = paths[0]?.hops;
  const found = shortestHops !== undefined;
  const exhaustive = search.exhaustive;
  const limitations = search.limitations;
  const resultContext = {
    start: parsed.start.address,
    goal: parsed.goal.address,
    explored: summarizeSearch(graph, search.reached),
    evidence_links: uniqueEvidence(snapshots.values()),
    limitations: [...new Set(limitations)].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
  const searchScope = { exhaustive };
  if (found)
    return callPathResultSchema.parse({
      ...resultContext,
      status: "found",
      shortest_hops: shortestHops,
      search_scope: searchScope,
      paths,
    });
  return callPathResultSchema.parse({
    ...resultContext,
    status: exhaustive ? "not_found" : "unknown",
    shortest_hops: null,
    search_scope: searchScope,
    paths: [],
  });
};

const summarizeSearch = (
  graph: CallGraph,
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
  groups: CallPathInput["functions"],
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
): CallGraph => {
  const graph = new CallGraph();
  for (const [address, snapshot] of snapshots) {
    graph.mergeNode(address);
    for (const callee of snapshot.collections.callees.items) {
      const calleeAddress = normalizeAddress(callee.address);
      graph.mergeNode(calleeAddress);
      graph.mergeDirectedEdge(address, calleeAddress);
    }
  }
  return graph;
};

interface SearchInput {
  readonly graph: CallGraph;
  readonly snapshots: ReadonlyMap<string, FunctionSnapshot>;
  readonly start: string;
  readonly goal: string;
}

const inspectSearch = ({
  graph,
  snapshots,
  start,
  goal,
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
    const neighbors = graph
      .outNeighbors(node)
      .sort((left, right) => left.localeCompare(right));
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
  readonly graph: CallGraph;
  readonly start: string;
  readonly goal: string;
  readonly shortestDepth: number;
}

const enumeratePaths = ({
  graph,
  start,
  goal,
  shortestDepth,
}: EnumerationInput): {
  readonly paths: string[][];
} => {
  const output: string[][] = [];
  const state: EnumerationState = {
    graph,
    goal,
    path: [start],
    visited: new Set([start]),
    output,
  };
  enumerateAtDepth(state, shortestDepth);
  return { paths: output };
};

interface EnumerationState {
  readonly graph: CallGraph;
  readonly goal: string;
  readonly path: string[];
  readonly visited: Set<string>;
  readonly output: string[][];
}

const enumerateAtDepth = (state: EnumerationState, remaining: number): void => {
  const { graph, goal, path, visited, output } = state;
  const current = path.at(-1);
  if (current === undefined) return;
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
