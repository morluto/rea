import {
  createJavaScriptApplicationGraph,
  mergeJavaScriptApplicationNodes,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type {
  ApplicationEdge,
  ApplicationNode,
} from "./javascriptApplicationGraphSchemas.js";
import type { ParsedStaticLayer } from "./javascriptRuntimeReconciliationParsing.js";
import type { ParsedRuntimeCapture } from "./javascriptRuntimeReconciliationCaptureParsing.js";
import { joinCoverageStatus } from "../coverage.js";
import {
  known,
  knownOrNull,
  sumKnownCounts,
  unknownBecause,
  type Known,
} from "../known.js";
import { applicationCoverageKnowledge } from "./javascriptApplicationEvidenceSchemas.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { RuntimeProjection } from "./javascriptRuntimeReconciliationRuntime.js";

interface ReconciledGraphInput {
  readonly layers: readonly ParsedStaticLayer[];
  readonly captures: readonly ParsedRuntimeCapture[];
  readonly runtime: RuntimeProjection;
  readonly reconciliationEdges: readonly ApplicationEdge[];
  readonly omittedReconciliationItems: number;
}

interface GraphCoverageFacts {
  readonly projectionOmissions: number;
  /** Projection plus source omissions; unknown when any source cannot count. */
  readonly omissions: Known<number>;
  readonly inputStatus: ReconciliationInputStatus;
  readonly inputTruncated: boolean;
  readonly outputTruncated: boolean;
}

/** What the static graphs and passive captures establish about their coverage. */
export type ReconciliationInputStatus =
  | "complete"
  | "partial"
  | "truncated"
  | "unknown";

/**
 * The one reading of reconciliation input coverage. Bounded captures report
 * only known gaps; a static graph whose producer could not tell or could not
 * run makes the inputs unknown, which wins over a known truncation.
 * `truncated` keeps a known input truncation even when the status is unknown.
 */
export const reconciliationInputCoverage = (
  input: Pick<ReconciledGraphInput, "layers" | "captures">,
): {
  readonly status: ReconciliationInputStatus;
  readonly truncated: boolean;
} => {
  const coverage = joinCoverageStatus([
    "complete",
    ...input.layers.map(({ graph }) =>
      applicationCoverageKnowledge(graph.coverage.status),
    ),
    ...input.captures.map(({ inspection }) =>
      inspection.completeness.status === "complete_within_window"
        ? ("complete" as const)
        : ("partial" as const),
    ),
  ]);
  const truncated =
    input.layers.some(({ graph }) => graph.coverage.truncated) ||
    input.captures.some(({ inspection }) =>
      inspection.completeness.conditions.includes("truncated"),
    );
  return {
    status:
      coverage === "unknown" ? "unknown" : truncated ? "truncated" : coverage,
    truncated,
  };
};

/** Combined graph plus omissions introduced while merging its observations. */
export interface ReconciledApplicationGraphProjection {
  readonly graph: JavaScriptApplicationGraph;
  readonly omittedGraphItems: number;
}

/** Merge source graphs, runtime nodes, and inferred mappings into one valid JAG. */
export const buildReconciledApplicationGraph = (
  input: ReconciledGraphInput,
): ReconciledApplicationGraphProjection => {
  const merged = mergeJavaScriptApplicationNodes([
    ...input.layers.flatMap(({ graph }) => graph.nodes),
    ...input.runtime.nodes,
  ]);
  const allEdges = uniqueEdges([
    ...input.layers.flatMap(({ graph }) => graph.edges),
    ...input.runtime.edges,
    ...input.reconciliationEdges,
  ]);
  const bounded = boundGraphContent(input, merged, allEdges);
  const facts = graphCoverageFacts(input, bounded.omittedItems);
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: bounded.rootNodeIds,
    nodes: bounded.nodes,
    edges: bounded.edges,
    coverage: graphCoverage(input, facts, bounded.nodes.length),
    limitations: uniqueSorted([
      ...input.layers.flatMap(({ graph }) => graph.limitations),
      "Runtime presence is bounded to passive capture windows and does not prove feature execution.",
      "Cross-layer observed_as edges are inferences; digest equality proves byte identity only.",
      "Source-map relationships retain their original static authority and are not promoted into runtime matches.",
      ...(facts.inputTruncated
        ? [
            "One or more source graphs or passive captures were incomplete or truncated.",
          ]
        : []),
      ...(facts.inputStatus === "unknown"
        ? [
            "One or more source graphs could not establish their coverage, so the reconciled graph's coverage is unknown.",
          ]
        : []),
      ...(facts.outputTruncated
        ? [
            "The reconciled graph omitted entities or classifications during projection.",
          ]
        : []),
    ]),
  });
  return {
    graph,
    omittedGraphItems: bounded.omittedItems,
  };
};

const boundGraphContent = (
  input: ReconciledGraphInput,
  nodes: readonly ApplicationNode[],
  edges: readonly ApplicationEdge[],
): {
  readonly rootNodeIds: string[];
  readonly nodes: ApplicationNode[];
  readonly edges: ApplicationEdge[];
  readonly omittedItems: number;
} => {
  const allRoots = preferredRootIds(input);
  const rootNodeIds = allRoots;
  const sortedNodes = [...nodes].sort((left, right) =>
    compareUnicodeCodePoints(left.node_id, right.node_id),
  );
  const retainedNodes = sortedNodes;
  const retainedIds = new Set(retainedNodes.map(({ node_id: id }) => id));
  const retainedEdges = [...edges]
    .sort((left, right) =>
      compareUnicodeCodePoints(left.edge_id, right.edge_id),
    )
    .filter(
      ({ source_node_id: source, target_node_id: target }) =>
        retainedIds.has(source) && retainedIds.has(target),
    );
  return {
    rootNodeIds,
    nodes: retainedNodes,
    edges: retainedEdges,
    omittedItems: 0,
  };
};

const preferredRootIds = (input: ReconciledGraphInput): string[] => {
  const runtime = [...input.runtime.targetNodeByEvidenceId.values()].map(
    ({ node_id: id }) => id,
  );
  const application = input.layers
    .filter(({ role }) => role === "application")
    .flatMap(({ graph }) => graph.root_node_ids);
  const supplemental = input.layers
    .filter(({ role }) => role !== "application")
    .flatMap(({ graph }) => graph.root_node_ids);
  return [...new Set([...runtime, ...application, ...supplemental])];
};

const graphCoverageFacts = (
  input: ReconciledGraphInput,
  omittedNodeObservations: number,
): GraphCoverageFacts => {
  const projectionOmissions =
    input.runtime.omittedEntities +
    input.omittedReconciliationItems +
    omittedNodeObservations;
  const captureTruncated = input.captures.some(({ inspection }) =>
    inspection.completeness.conditions.includes("truncated"),
  );
  const captureHasUnknownOmissions = input.captures.some(
    ({ inspection }) =>
      inspection.completeness.attach_limited_sections.length > 0 ||
      inspection.completeness.unavailable_sections.length > 0,
  );
  const outputTruncated = projectionOmissions > 0;
  const omissions = captureTruncated
    ? unknownBecause("a passive capture is truncated")
    : captureHasUnknownOmissions
      ? unknownBecause(
          "a passive capture has attach-limited or unavailable sections",
        )
      : sumKnownCounts([
          known(projectionOmissions),
          ...input.layers.map(({ graph }) =>
            graph.coverage.omitted_count === null
              ? unknownBecause("a static graph did not count its omissions")
              : known(graph.coverage.omitted_count),
          ),
        ]);
  const inputCoverage = reconciliationInputCoverage(input);
  return {
    projectionOmissions,
    omissions,
    inputStatus: inputCoverage.status,
    inputTruncated: inputCoverage.truncated,
    outputTruncated,
  };
};

const graphCoverage = (
  input: ReconciledGraphInput,
  facts: GraphCoverageFacts,
  nodeCount: number,
): JavaScriptApplicationGraph["coverage"] =>
  facts.inputStatus === "unknown"
    ? { status: "unknown", truncated: false, omitted_count: null, limits: [] }
    : facts.inputStatus === "complete" && !facts.outputTruncated
      ? { status: "complete", truncated: false, omitted_count: 0, limits: [] }
      : facts.inputStatus === "truncated" || facts.outputTruncated
        ? {
            status: "partial",
            truncated: true,
            omitted_count: knownOrNull(facts.omissions, (count) => count),
            limits: [
              ...(facts.inputStatus === "truncated"
                ? [
                    {
                      name: "runtime-reconciliation-input-coverage",
                      value: input.layers.length + input.captures.length,
                      unit: "items" as const,
                    },
                  ]
                : []),
              ...(facts.outputTruncated
                ? [
                    {
                      name: "runtime-reconciliation-output-limits",
                      value: nodeCount,
                      unit: "items" as const,
                    },
                  ]
                : []),
            ],
          }
        : {
            status: "partial",
            truncated: false,
            omitted_count: knownOrNull(facts.omissions, (count) => count),
            limits: [],
          };

const uniqueEdges = (edges: readonly ApplicationEdge[]): ApplicationEdge[] => [
  ...new Map(edges.map((edge) => [edge.edge_id, edge])).values(),
];
