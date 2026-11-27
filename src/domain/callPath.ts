import { z } from "zod";
import {
  combineRelationshipDiscovery,
  relationshipCoverageLimitations,
  type RelationshipDiscoveryStatus,
} from "./relationshipCoverage.js";
import {
  callPathInputSchema,
  callPathResultSchema,
  CALL_PATH_REPRESENTATION_BUDGET_BYTES,
  DEFAULT_CALL_PATH_MAX_PATHS,
  type CallPathResult,
  type OutputCallPath,
} from "./callPathSchemas.js";
import { AnalysisInputError } from "./analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "./inputIssueProjection.js";
import { readEvidencePayload } from "./evidenceValidation.js";
import { nativeAddressInputSchema } from "./native/nativeAddress.js";
import { functionCoordinateContextsEqual } from "./native/functionCoordinateContext.js";
import {
  parseFunctionEvidence,
  type FunctionSnapshot,
} from "./functionDossierEvidence.js";
import { isCallerOnlyIncompleteCoverage } from "./functionCallCoverage.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { appendAll } from "./appendAll.js";
import { CitedPathParts, snapshotLinks } from "./callPathCitations.js";
import { sameTargetCoordinates } from "./targetIdentity.js";

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

/** First count past the exactly representable range: 2^53. */
const SHORTEST_PATH_COUNT_CAP = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

/**
 * Count shortest start-to-goal paths without enumerating them.
 *
 * Every path uses only edges that reduce the distance to the goal by one, so the
 * count follows from one pass over those nodes in increasing distance order. The
 * walk is bounded by the graph, which is why the reported total stays cheap even
 * when the number of paths is far past what any inline list could hold.
 *
 * Each stored count is capped as it is computed. A total that reaches the cap is
 * reported together with `capped`, so a caller can tell an exact count from one
 * that only bounds the true value; without that flag the capped number would be
 * indistinguishable from an exact count one below it.
 */
const countShortestPaths = (
  graph: CallGraph,
  start: string,
  goal: string,
  goalDistances: ReadonlyMap<string, number>,
): { readonly total: number; readonly capped: boolean } => {
  if (!goalDistances.has(start)) return { total: 0, capped: false };
  const byDistance = [...goalDistances.entries()].sort(
    (left, right) => left[1] - right[1],
  );
  const counts = new Map<string, bigint>();
  for (const [node, distance] of byDistance) {
    if (node === goal) {
      counts.set(node, 1n);
      continue;
    }
    let total = 0n;
    for (const neighbor of graph.outNeighbors(node))
      if (goalDistances.get(neighbor) === distance - 1)
        total += counts.get(neighbor) ?? 0n;
    counts.set(
      node,
      total > SHORTEST_PATH_COUNT_CAP ? SHORTEST_PATH_COUNT_CAP : total,
    );
  }
  const total = counts.get(start) ?? 0n;
  const capped = total >= SHORTEST_PATH_COUNT_CAP;
  return {
    total: capped ? Number.MAX_SAFE_INTEGER : Number(total),
    capped,
  };
};

interface SearchState {
  readonly graph: CallGraph;
  readonly snapshots: ReadonlyMap<string, FunctionSnapshot>;
  /**
   * Forward-search extent, counted where the search does its work: functions
   * discovered (including unexpanded terminals), direct-callee edges examined
   * while expanding non-goal functions, and the greatest discovery depth.
   */
  readonly explored: CallPathResult["explored"];
  readonly exhaustive: boolean;
  readonly discovery: RelationshipDiscoveryStatus;
  readonly limitations: readonly string[];
}

const callPathEnvelopeSchema = callPathInputSchema.extend({
  functions: z.array(z.unknown()).min(1),
});

/** Reconstruct direct-callee paths from explicit analyze_function Evidence. */
export const buildCallPath = (input: unknown): CallPathResult => {
  const selected = callPathEnvelopeSchema.safeParse(input);
  if (!selected.success)
    throw analysisInputErrorFromIssues(
      "build_call_path",
      selected.error.issues,
      input,
      { cause: selected.error },
    );
  const parsed = selected.data;
  const { snapshots, graph } = prepareCallGraph(parsed);
  const search = inspectSearch({
    graph,
    snapshots,
    start: parsed.start.address,
    goal: parsed.goal.address,
  });
  const goalDistances = distancesToGoal(graph, parsed.goal.address);
  const shortestDepth = goalDistances.get(parsed.start.address) ?? null;
  // Counting and enumerating are separate costs. The exact total is derived from
  // the same distance graph without materializing a path, so a caller always
  // learns how many paths exist even when only a prefix is returned.
  const shortestPathCount = countShortestPaths(
    graph,
    parsed.start.address,
    parsed.goal.address,
    goalDistances,
  );
  const enumeration =
    shortestDepth === null
      ? { paths: [] as OutputCallPath[], limitedByBytes: false }
      : enumeratePaths({
          graph,
          start: parsed.start.address,
          goal: parsed.goal.address,
          goalDistances,
          snapshots,
          byteBudget: CALL_PATH_REPRESENTATION_BUDGET_BYTES,
          // The default belongs to this owner, not to input parsing: admission
          // must keep omission distinguishable from an explicit `max_paths`.
          maxPaths: parsed.max_paths ?? DEFAULT_CALL_PATH_MAX_PATHS,
        });
  const paths = enumeration.paths;
  const exhaustive = search.exhaustive;
  const limitations = enumeration.limitedByBytes
    ? [
        ...search.limitations,
        `The inline shortest-path list reached its ${String(CALL_PATH_REPRESENTATION_BUDGET_BYTES)}-byte serialized representation budget; a canonical prefix is returned.`,
      ]
    : search.limitations;
  const resultContext = {
    start: parsed.start.address,
    goal: parsed.goal.address,
    explored: search.explored,
    total_shortest_paths: shortestPathCount.total,
    total_shortest_paths_capped: shortestPathCount.capped,
    paths_truncated:
      paths.length < shortestPathCount.total || shortestPathCount.capped,
    paths_limited_by_bytes: enumeration.limitedByBytes,
    evidence_links: uniqueEvidence(snapshots.values()),
    limitations: [...new Set(limitations)].sort(compareUnicodeCodePoints),
  };
  const found = shortestDepth !== null;
  const searchScope = {
    exhaustive,
    graph: "supplied_evidence" as const,
    discovery: search.discovery,
    observed_status: found
      ? ("found" as const)
      : exhaustive
        ? ("not_found" as const)
        : ("unknown" as const),
  };
  if (found)
    return callPathResultSchema.parse({
      ...resultContext,
      status: "found",
      shortest_hops: shortestDepth,
      search_scope: searchScope,
      paths,
    });
  return callPathResultSchema.parse({
    ...resultContext,
    status:
      exhaustive && search.discovery === "complete" ? "not_found" : "unknown",
    shortest_hops: null,
    search_scope: searchScope,
    paths: [],
  });
};

const prepareCallGraph = (input: z.infer<typeof callPathEnvelopeSchema>) => {
  const { snapshots, graph } = parseSnapshots(input.functions);
  assertCompatible(snapshots);
  if (!snapshots.has(input.start.address))
    throw invalidCallPathSelection(
      ["start", "address"],
      `No analyze_function Evidence was supplied for start ${input.start.address}`,
    );
  return { snapshots, graph };
};

const parseSnapshots = (
  groups: readonly unknown[],
): {
  readonly snapshots: Map<string, FunctionSnapshot>;
  readonly graph: CallGraph;
} => {
  const snapshots = new Map<string, FunctionSnapshot>();
  const graph = new CallGraph();
  for (const [index, group] of groups.entries()) {
    const parsed = parseFunctionEvidence(group, {
      operation: "build_call_path",
      path: ["functions", index],
    });
    if (!parsed.ok) throw parsed.error;
    const snapshot = parsed.value;
    const parsedAddress = readEvidencePayload(
      nativeAddressInputSchema,
      snapshot.dossier.procedure.address,
    );
    if (!parsedAddress.ok) throw parsedAddress.error;
    const address = parsedAddress.value;
    if (snapshots.has(address))
      throw invalidCallPathSelection(
        ["functions", index],
        `Duplicate function Evidence for ${address}`,
      );
    graph.mergeNode(address);
    for (const callee of snapshot.dossier.callees) {
      const parsedCallee = readEvidencePayload(
        nativeAddressInputSchema,
        callee.address,
      );
      if (!parsedCallee.ok) throw parsedCallee.error;
      graph.mergeDirectedEdge(address, parsedCallee.value);
    }
    snapshots.set(address, snapshot);
  }
  return { snapshots, graph };
};

const assertCompatible = (
  snapshots: ReadonlyMap<string, FunctionSnapshot>,
): void => {
  const firstEntry = snapshots.values().next();
  if (firstEntry.done) return;
  const first = firstEntry.value;
  for (const snapshot of snapshots.values()) {
    if (!sameTargetCoordinates(snapshot.target, first.target))
      throw invalidCallPathSelection(
        ["functions"],
        "Call-path Evidence mixes artifact subjects",
      );
    if (
      snapshot.evidence.provider.id !== first.evidence.provider.id ||
      snapshot.evidence.provider.name !== first.evidence.provider.name ||
      snapshot.evidence.provider.version !== first.evidence.provider.version
    )
      throw invalidCallPathSelection(
        ["functions"],
        "Call-path Evidence mixes providers",
      );
    const firstProfile = first.evidence.analysis_profile;
    const profile = snapshot.evidence.analysis_profile;
    if (
      (firstProfile?.parameters.function_coordinate_context !== undefined ||
        profile?.parameters.function_coordinate_context !== undefined) &&
      !functionCoordinateContextsEqual(firstProfile, profile)
    )
      throw invalidCallPathSelection(
        ["functions"],
        "Call-path Evidence has incompatible or unestablished function coordinate contexts",
      );
  }
};

const invalidCallPathSelection = (
  path: readonly (string | number)[],
  message: string,
): AnalysisInputError =>
  new AnalysisInputError("build_call_path", { userMessage: message }, [
    { path, reason: "invalid_value", message },
  ]);

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
  const reached = new Map<string, number>([[start, 0]]);
  const queue = [start];
  const limitations: string[] = [];
  let incompleteExpandedCoverage = false;
  let discovery: RelationshipDiscoveryStatus = "complete";
  let expandedEdges = 0;
  let depthReached = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    if (node === undefined) continue;
    const depth = reached.get(node) ?? 0;
    depthReached = Math.max(depthReached, depth);
    const snapshot = snapshots.get(node);
    if (snapshot !== undefined) {
      const coverage = snapshot.evidence.relationship_coverage;
      for (const limitation of snapshot.limitations)
        limitations.push(limitation);
      appendAll(limitations, snapshot.unresolvedCallCaveats);
      if (coverage !== null) {
        for (const limitation of relationshipCoverageLimitations(coverage))
          limitations.push(limitation);
        for (const diagnostic of coverage.diagnostics ?? [])
          limitations.push(diagnostic);
      }
      // The requested goal is a terminal for this search. Its outgoing edges
      // cannot add a path to the goal, so its dossier limits are contextual
      // but do not make the searched start-to-goal closure incomplete.
      if (node === goal) continue;
      const discoveryFact = coverage?.discovery?.callees;
      if (
        discoveryFact !== undefined &&
        discoveryFact.status !== "complete" &&
        discoveryFact.reason !== undefined
      )
        limitations.push(
          `Call discovery for ${node} is ${discoveryFact.status}: ${discoveryFact.reason}`,
        );
      discovery = combineRelationshipDiscovery(discovery, coverage, "callees");
      if (snapshot.unresolvedCallCaveats.length > 0)
        incompleteExpandedCoverage = true;
      const callees = snapshot.dossier.facet_availability?.callees;
      if (callees?.available === false) {
        limitations.push(callees.reason);
        incompleteExpandedCoverage = true;
      }
      // Explicit, Evidence-bound relationship coverage owns completeness;
      // generic provider/dossier limitations remain contextual. Evidence from
      // a provider that reports no relationship coverage keeps the
      // conservative limitation-based rule.
      // The search only expands callee edges, so coverage that is unknown
      // solely because callers are unobservable does not make the searched
      // callee closure incomplete; the caller caveat stays in limitations.
      if (
        coverage === null
          ? snapshot.limitations.length > 0
          : coverage.status !== "complete" &&
            !isCallerOnlyIncompleteCoverage(coverage)
      )
        incompleteExpandedCoverage = true;
    } else if (node === goal) {
      continue;
    }
    if (snapshot === undefined) {
      discovery = combineRelationshipDiscovery(discovery, null, "callees");
      limitations.push(
        `No analyze_function Evidence covers reachable function ${node}`,
      );
      incompleteExpandedCoverage = true;
      continue;
    }
    const neighbors = graph.outNeighbors(node).sort(compareUnicodeCodePoints);
    // Count only edges this expansion examines; a terminal goal's outgoing
    // relationships never reach this point and so never count as explored.
    expandedEdges += neighbors.length;
    for (const neighbor of neighbors)
      if (!reached.has(neighbor)) {
        reached.set(neighbor, depth + 1);
        queue.push(neighbor);
      }
  }
  return {
    graph,
    snapshots,
    explored: {
      nodes: reached.size,
      edges: expandedEdges,
      depth_reached: depthReached,
    },
    exhaustive: !incompleteExpandedCoverage,
    discovery,
    limitations,
  };
};

interface EnumerationInput {
  readonly graph: CallGraph;
  readonly start: string;
  readonly goal: string;
  readonly goalDistances: ReadonlyMap<string, number>;
  readonly snapshots: ReadonlyMap<string, FunctionSnapshot>;
  readonly byteBudget: number;
  /** Caller-selected count preference, subordinate to the representation bound. */
  readonly maxPaths: number;
}

const enumeratePaths = ({
  graph,
  start,
  goal,
  goalDistances,
  snapshots,
  byteBudget,
  maxPaths,
}: EnumerationInput): {
  readonly paths: OutputCallPath[];
  readonly limitedByBytes: boolean;
} => {
  const output: OutputCallPath[] = [];
  // The `paths` array's brackets frame every cited path: one before the first
  // and one after the last. Both are reserved here because
  // each measured cited path excludes the array around it.
  let retainedBytes = 2;
  let limitedByBytes = false;
  const parts = new CitedPathParts(snapshots);
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
        .sort(compareUnicodeCodePoints);
      neighbors.set(node, candidates);
    }
    return { neighbors: candidates, nextIndex: 0 };
  };
  const pending = [frame(start)];
  while (pending.length > 0) {
    const current = pending.at(-1);
    if (current === undefined) break;
    if (path.at(-1) === goal) {
      // Measure from cached parts before assembling, so a rejected path
      // allocates no representation. The first shortest path is linear in the
      // supplied Evidence and is always returned; the budget bounds the rest.
      const citedBytes = parts.measure(path);
      const separatorBytes = output.length === 0 ? 0 : 1;
      // `retainedBytes` holds the opening bracket and every cited path, so the
      // budget left for this path and its separator also has to keep room for the
      // closing bracket that follows the last path.
      if (
        output.length > 0 &&
        citedBytes + separatorBytes > byteBudget - retainedBytes
      ) {
        limitedByBytes = true;
        break;
      }
      output.push(parts.assemble(path));
      retainedBytes += citedBytes + separatorBytes;
      pending.pop();
      path.pop();
      // Count capacity is a caller preference. Serialized representation size
      // is the resource bound, so stop before forming the next cited path.
      if (output.length >= maxPaths) break;
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
  return { paths: output, limitedByBytes };
};

interface EnumerationFrame {
  readonly neighbors: readonly string[];
  nextIndex: number;
}

const uniqueEvidence = (snapshots: Iterable<FunctionSnapshot>): string[] =>
  [
    ...new Set([...snapshots].flatMap((snapshot) => snapshotLinks(snapshot))),
  ].sort(compareUnicodeCodePoints);
