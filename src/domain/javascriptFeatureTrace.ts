import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type { Evidence } from "./evidence.js";
import {
  compareCodePoints,
  createJavaScriptApplicationGraph,
  type ApplicationEdge,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import {
  applicationFeatureTraceResultSchema,
  type ApplicationFeatureTraceResult,
  type TraceApplicationFeatureInput,
} from "./javascriptFeatureTraceSchemas.js";
import {
  findApplicationFeatureSeeds,
  type ApplicationFeatureSeedMatch,
} from "./javascriptFeatureSeed.js";
import {
  traverseApplicationFeature,
  type ApplicationFeatureTraversal,
} from "./javascriptFeatureTraversal.js";
import { buildJavaScriptNativeHandoffs } from "./javascriptNativeHandoff.js";

/** Pure, authenticated inputs projected by the application service. */
export interface ApplicationFeatureTraceProjectionInput {
  readonly sourceEvidenceId: string;
  readonly graph: JavaScriptApplicationGraph;
  readonly nativeEvidence: readonly Evidence[];
  readonly seed: TraceApplicationFeatureInput["seed"];
  readonly direction: TraceApplicationFeatureInput["direction"];
  readonly limits: TraceApplicationFeatureInput["limits"];
}

/** Trace a literal feature through a bounded, authority-preserving JAG. */
export const traceApplicationFeature = (
  input: ApplicationFeatureTraceProjectionInput,
): ApplicationFeatureTraceResult => {
  const allSeedMatches = findApplicationFeatureSeeds(
    input.graph.nodes,
    input.seed,
  );
  const seedMatches = allSeedMatches.slice(0, input.limits.max_seed_matches);
  if (seedMatches.length === 0) return noMatchResult(input);
  const traversal = traverseApplicationFeature(
    input.graph,
    seedMatches.map(({ node_id: id }) => id),
    input.direction,
    input.limits,
  );
  const graph = traceGraph(
    input,
    seedMatches,
    traversal,
    allSeedMatches.length,
  );
  const allPaths = terminalPaths(traversal, seedMatches);
  const paths = allPaths.slice(0, input.limits.max_paths);
  const nativeHandoffs = buildJavaScriptNativeHandoffs(
    traversal.nodes,
    traversal.edges,
    input.nativeEvidence,
  );
  const evidenceLinks = uniqueSorted([
    input.sourceEvidenceId,
    ...nativeHandoffs.flatMap(({ evidence_ids: ids }) => ids),
  ]);
  const omissions = traceOmissions(
    input,
    traversal,
    allSeedMatches.length,
    allPaths.length,
  );
  const semantic = {
    schema_version: 1 as const,
    source_evidence_id: input.sourceEvidenceId,
    source_graph_id: input.graph.graph_id,
    seed: input.seed,
    direction: input.direction,
    seed_matches: seedMatches,
    graph,
    paths,
    native_handoffs: nativeHandoffs,
    summary: {
      matched_seeds: seedMatches.length,
      traced_nodes: traversal.nodes.length,
      traced_edges: traversal.edges.length,
      terminal_paths: paths.length,
      native_handoffs: nativeHandoffs.length,
      ...factSummary(traversal.nodes, traversal.edges),
    },
    coverage: {
      status: traceCoverageStatus(input.graph, omissions),
      source_graph_status: input.graph.coverage.status,
      scanned_nodes: input.graph.nodes.length,
      total_seed_matches: allSeedMatches.length,
      ...omissions,
      frontier_node_ids: traversal.frontierNodeIds,
    },
    evidence_links: evidenceLinks,
    limitations: traceLimitations(input.graph, omissions),
  };
  return applicationFeatureTraceResultSchema.parse({
    ...semantic,
    trace_id: `jatr_${digestCanonical(semantic)}`,
  });
};

const noMatchResult = (
  input: ApplicationFeatureTraceProjectionInput,
): ApplicationFeatureTraceResult => {
  const semantic = {
    schema_version: 1 as const,
    source_evidence_id: input.sourceEvidenceId,
    source_graph_id: input.graph.graph_id,
    seed: input.seed,
    direction: input.direction,
    seed_matches: [],
    graph: null,
    paths: [],
    native_handoffs: [],
    summary: {
      matched_seeds: 0,
      traced_nodes: 0,
      traced_edges: 0,
      terminal_paths: 0,
      native_handoffs: 0,
      observed_facts: 0,
      inferred_facts: 0,
      unknown_facts: 0,
      unavailable_facts: 0,
    },
    coverage: {
      status: "no-match" as const,
      source_graph_status: input.graph.coverage.status,
      scanned_nodes: input.graph.nodes.length,
      total_seed_matches: 0,
      omitted_seed_matches: 0,
      omitted_nodes: 0,
      omitted_edges: 0,
      omitted_paths: 0,
      frontier_node_ids: [],
    },
    evidence_links: [input.sourceEvidenceId],
    limitations: uniqueSorted([
      "No graph entity matched the literal seed; this is not evidence that the feature is absent.",
      ...sourceCoverageLimitations(input.graph),
    ]),
  };
  return applicationFeatureTraceResultSchema.parse({
    ...semantic,
    trace_id: `jatr_${digestCanonical(semantic)}`,
  });
};

const traceGraph = (
  input: ApplicationFeatureTraceProjectionInput,
  seedMatches: readonly ApplicationFeatureSeedMatch[],
  traversal: ApplicationFeatureTraversal,
  totalSeedMatches: number,
): JavaScriptApplicationGraph => {
  const omitted =
    traversal.omittedNodeCount +
    traversal.omittedEdgeCount +
    (totalSeedMatches - seedMatches.length);
  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    schema_version: 1,
    root_node_ids: uniqueSorted(seedMatches.map(({ node_id: id }) => id)),
    nodes: traversal.nodes,
    edges: traversal.edges,
    coverage: traceGraphCoverage(input.graph, input.limits, omitted),
    limitations: uniqueSorted([
      ...input.graph.limitations,
      "Trace edges retain their source authority; graph connectivity does not prove runtime execution or reachability.",
      ...(omitted === 0
        ? []
        : ["Trace output stopped at explicit caller bounds."]),
    ]),
  });
};

const traceGraphCoverage = (
  source: JavaScriptApplicationGraph,
  limits: TraceApplicationFeatureInput["limits"],
  omitted: number,
): JavaScriptApplicationGraph["coverage"] => {
  if (omitted > 0)
    return {
      status: "partial",
      truncated: true,
      omitted_count: omitted,
      limits: [
        {
          name: "max-seed-matches",
          value: limits.max_seed_matches,
          unit: "items",
        },
        { name: "max-depth", value: limits.max_depth, unit: "depth" },
        { name: "max-nodes", value: limits.max_nodes, unit: "items" },
        { name: "max-edges", value: limits.max_edges, unit: "items" },
      ],
    };
  return source.coverage.status === "complete"
    ? { status: "complete", truncated: false, omitted_count: 0, limits: [] }
    : {
        status: source.coverage.status,
        truncated: source.coverage.truncated,
        omitted_count: source.coverage.omitted_count,
        limits: source.coverage.limits,
      };
};

const terminalPaths = (
  traversal: ApplicationFeatureTraversal,
  seeds: readonly ApplicationFeatureSeedMatch[],
): ApplicationFeatureTraceResult["paths"] => {
  const seedIds = new Set(seeds.map(({ node_id: id }) => id));
  const edgeById = new Map(traversal.edges.map((edge) => [edge.edge_id, edge]));
  return traversal.nodes
    .filter(
      (node) =>
        isTerminal(node) &&
        (!seedIds.has(node.node_id) || traversal.nodes.length === 1),
    )
    .map((node) => pathTo(node, traversal.predecessors, edgeById))
    .filter((path): path is NonNullable<typeof path> => path !== null)
    .sort((left, right) => compareCodePoints(left.path_id, right.path_id));
};

const pathTo = (
  node: ApplicationNode,
  predecessors: ApplicationFeatureTraversal["predecessors"],
  edgeById: ReadonlyMap<string, ApplicationEdge>,
): ApplicationFeatureTraceResult["paths"][number] | null => {
  const nodeIds = [node.node_id];
  const edgeIds: string[] = [];
  let current = node.node_id;
  while (predecessors.has(current)) {
    const predecessor = predecessors.get(current);
    if (predecessor === undefined) break;
    nodeIds.push(predecessor.previousNodeId);
    edgeIds.push(predecessor.edgeId);
    current = predecessor.previousNodeId;
  }
  nodeIds.reverse();
  edgeIds.reverse();
  const edges = edgeIds
    .map((edgeId) => edgeById.get(edgeId))
    .filter((edge): edge is ApplicationEdge => edge !== undefined);
  if (edges.length !== edgeIds.length) return null;
  const semantic = {
    start_node_id: nodeIds[0] ?? node.node_id,
    end_node_id: node.node_id,
    end_kind: node.kind,
    node_ids: nodeIds,
    edge_ids: edgeIds,
    authorities: uniqueSorted(edges.map(({ evidence }) => evidence.authority)),
    contains_inference: edges.some(
      ({ evidence }) => evidence.state === "inferred",
    ),
  };
  return { ...semantic, path_id: `jatp_${digestCanonical(semantic)}` };
};

const isTerminal = (node: ApplicationNode): boolean =>
  ["endpoint", "storage", "native-addon", "native-export", "unknown"].includes(
    node.kind,
  );

const factSummary = (
  nodes: readonly ApplicationNode[],
  edges: readonly ApplicationEdge[],
) => {
  const states = [
    ...nodes.flatMap(({ observations }) =>
      observations.map(({ evidence }) => evidence.state),
    ),
    ...edges.map(({ evidence }) => evidence.state),
  ];
  return {
    observed_facts: states.filter((state) => state === "observed").length,
    inferred_facts: states.filter((state) => state === "inferred").length,
    unknown_facts: states.filter((state) => state === "unknown").length,
    unavailable_facts: states.filter((state) => state === "unavailable").length,
  };
};

const traceOmissions = (
  input: ApplicationFeatureTraceProjectionInput,
  traversal: ApplicationFeatureTraversal,
  seedMatches: number,
  paths: number,
) => ({
  omitted_seed_matches: Math.max(
    0,
    seedMatches - input.limits.max_seed_matches,
  ),
  omitted_nodes: traversal.omittedNodeCount,
  omitted_edges: traversal.omittedEdgeCount,
  omitted_paths: Math.max(0, paths - input.limits.max_paths),
});

const traceCoverageStatus = (
  graph: JavaScriptApplicationGraph,
  omissions: ReturnType<typeof traceOmissions>,
): ApplicationFeatureTraceResult["coverage"]["status"] =>
  Object.values(omissions).some((value) => value > 0)
    ? "truncated"
    : graph.coverage.status === "complete"
      ? "complete-within-source"
      : "partial";

const traceLimitations = (
  graph: JavaScriptApplicationGraph,
  omissions: ReturnType<typeof traceOmissions>,
): string[] =>
  uniqueSorted([
    "A trace reports graph relationships, not proof that code executed or that a feature is reachable in every state.",
    "Static, native, passive-runtime, inferred, and unknown facts retain their original authority in the returned graph.",
    "Native handoffs never open a binary or invoke a provider automatically; snapshot reuse remains provider/profile/target exact.",
    ...sourceCoverageLimitations(graph),
    ...(Object.values(omissions).some((value) => value > 0)
      ? ["Trace results were truncated at explicit caller limits."]
      : []),
  ]);

const sourceCoverageLimitations = (
  graph: JavaScriptApplicationGraph,
): string[] =>
  graph.coverage.status === "complete"
    ? []
    : [
        "The source application graph is incomplete; unmatched seeds and frontiers remain unknown.",
      ];

const digestCanonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Feature trace could not canonicalize data");
  return createHash("sha256").update(encoded).digest("hex");
};

const uniqueSorted = <Value extends string>(
  values: readonly Value[],
): Value[] => [...new Set(values)].sort(compareCodePoints);
