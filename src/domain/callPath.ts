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

/** Minimal directed caller-to-callee adjacency for call-path search. */
class CallGraph {
  private readonly successors = new Map<string, Set<string>>();
  private readonly predecessors = new Map<string, Set<string>>();

  mergeNode(node: string): void {
    if (!this.successors.has(node)) this.successors.set(node, new Set());
    if (!this.predecessors.has(node)) this.predecessors.set(node, new Set());
  }

  mergeDirectedEdge(source: string, target: string): void {
    this.mergeNode(source);
    this.mergeNode(target);
    this.successors.get(source)?.add(target);
    this.predecessors.get(target)?.add(source);
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

  inNeighbors(node: string): string[] {
    return [...(this.predecessors.get(node) ?? [])];
  }
}

/** Shortest remaining distance for every node that can reach the goal. */
const distancesToGoal = (
  graph: CallGraph,
  goal: string,
): ReadonlyMap<string, number> => {
  if (!graph.hasNode(goal)) return new Map();
  const depth = new Map<string, number>([[goal, 0]]);
  const queue = [goal];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index] ?? "";
    const next = (depth.get(node) ?? 0) + 1;
    for (const neighbor of graph.inNeighbors(node)) {
      if (!depth.has(neighbor)) {
        depth.set(neighbor, next);
        queue.push(neighbor);
      }
    }
  }
  return depth;
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
  const goalDistances = distancesToGoal(graph, parsed.goal.address);
  const shortestDepth = goalDistances.get(parsed.start.address) ?? null;
  const paths =
    shortestDepth === null
      ? []
      : enumeratePaths({
          graph,
          start: parsed.start.address,
          goal: parsed.goal.address,
          goalDistances,
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
  depth_reached: [...reached.values()].reduce(
    (maximum, depth) => Math.max(maximum, depth),
    0,
  ),
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
    const address = parseCallPathAddress(snapshot.dossier.procedure.address);
    for (const callee of snapshot.dossier.callees)
      parseCallPathAddress(callee.address);
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
      snapshot.evidence.provider.id !== first.evidence.provider.id ||
      snapshot.evidence.provider.name !== first.evidence.provider.name ||
      snapshot.evidence.provider.version !== first.evidence.provider.version
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
    for (const callee of snapshot.dossier.callees) {
      const calleeAddress = parseCallPathAddress(callee.address);
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
  readonly goalDistances: ReadonlyMap<string, number>;
}

const enumeratePaths = ({
  graph,
  start,
  goal,
  goalDistances,
}: EnumerationInput): {
  readonly paths: string[][];
} => {
  const output: string[][] = [];
  const path = [start];
  const neighbors = new Map<string, readonly string[]>();
  const frame = (node: string): EnumerationFrame => {
    let candidates = neighbors.get(node);
    if (candidates === undefined) {
      const distance = goalDistances.get(node);
      candidates = graph
        .outNeighbors(node)
        .filter(
          (neighbor) =>
            distance !== undefined &&
            goalDistances.get(neighbor) === distance - 1,
        )
        .sort((left, right) => left.localeCompare(right));
      neighbors.set(node, candidates);
    }
    return { neighbors: candidates, nextIndex: 0 };
  };
  const pending = [frame(start)];
  while (pending.length > 0) {
    const current = pending.at(-1);
    if (current === undefined) break;
    if (path.at(-1) === goal) {
      output.push([...path]);
      pending.pop();
      path.pop();
      continue;
    }
    const neighbor = current.neighbors[current.nextIndex];
    if (neighbor === undefined) {
      pending.pop();
      path.pop();
      continue;
    }
    current.nextIndex += 1;
    path.push(neighbor);
    pending.push(frame(neighbor));
  }
  return { paths: output };
};

interface EnumerationFrame {
  readonly neighbors: readonly string[];
  nextIndex: number;
}

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
      name: snapshot?.dossier.procedure.name ?? null,
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
  return [snapshot.evidence.evidence_id];
};

const uniqueEvidence = (snapshots: Iterable<FunctionSnapshot>): string[] =>
  [
    ...new Set([...snapshots].flatMap((snapshot) => snapshotLinks(snapshot))),
  ].sort((left, right) => left.localeCompare(right));
