import {
  compareCodePoints,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  type ApplicationEdge,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type {
  ParsedRuntimeCapture,
  ParsedStaticLayer,
} from "./javascriptRuntimeReconciliationParsing.js";
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
  readonly knownOmissions: number;
  readonly omissionsKnown: boolean;
  readonly inputTruncated: boolean;
  readonly outputTruncated: boolean;
  readonly truncated: boolean;
  readonly complete: boolean;
}

/** Combined graph plus omissions introduced while merging its observations. */
export interface ReconciledApplicationGraphProjection {
  readonly graph: JavaScriptApplicationGraph;
  readonly omittedGraphItems: number;
}

/** Merge source graphs, runtime nodes, and inferred mappings into one valid JAG. */
export const buildReconciledApplicationGraph = (
  input: ReconciledGraphInput,
): ReconciledApplicationGraphProjection => {
  const merged = mergeNodes([
    ...input.layers.flatMap(({ graph }) => graph.nodes),
    ...input.runtime.nodes,
  ]);
  const allEdges = uniqueEdges([
    ...input.layers.flatMap(({ graph }) => graph.edges),
    ...input.runtime.edges,
    ...input.reconciliationEdges,
  ]);
  const bounded = boundGraphContent(input, merged.nodes, allEdges);
  const facts = graphCoverageFacts(
    input,
    merged.omittedObservations + bounded.omittedItems,
  );
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    schema_version: 1,
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
      ...(facts.outputTruncated
        ? [
            "The reconciled graph omitted entities or classifications at caller limits.",
          ]
        : []),
    ]),
  });
  return {
    graph,
    omittedGraphItems: merged.omittedObservations + bounded.omittedItems,
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
  const rootNodeIds = allRoots.slice(0, 1_000);
  const roots = new Set(rootNodeIds);
  const sortedNodes = [...nodes].sort((left, right) =>
    compareCodePoints(left.node_id, right.node_id),
  );
  const retainedNodes = [
    ...sortedNodes.filter(({ node_id: id }) => roots.has(id)),
    ...sortedNodes.filter(({ node_id: id }) => !roots.has(id)),
  ].slice(0, 100_000);
  const retainedIds = new Set(retainedNodes.map(({ node_id: id }) => id));
  const retainedEdges = [...edges]
    .sort((left, right) => compareCodePoints(left.edge_id, right.edge_id))
    .filter(
      ({ source_node_id: source, target_node_id: target }) =>
        retainedIds.has(source) && retainedIds.has(target),
    )
    .slice(0, 200_000);
  return {
    rootNodeIds,
    nodes: retainedNodes,
    edges: retainedEdges,
    omittedItems:
      allRoots.length -
      rootNodeIds.length +
      (nodes.length - retainedNodes.length) +
      (edges.length - retainedEdges.length),
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
    ({ inspection }) => inspection.completeness.unavailable_sections.length > 0,
  );
  const inputTruncated =
    input.layers.some(({ graph }) => graph.coverage.truncated) ||
    captureTruncated;
  const outputTruncated = projectionOmissions > 0;
  const sourceOmissions = input.layers.reduce(
    (total, { graph }) => total + (graph.coverage.omitted_count ?? 0),
    0,
  );
  const omissionsKnown =
    !captureTruncated &&
    !captureHasUnknownOmissions &&
    input.layers.every(({ graph }) => graph.coverage.omitted_count !== null);
  return {
    projectionOmissions,
    knownOmissions: projectionOmissions + sourceOmissions,
    omissionsKnown,
    inputTruncated,
    outputTruncated,
    truncated: inputTruncated || outputTruncated,
    complete:
      !inputTruncated &&
      !outputTruncated &&
      input.layers.every(({ graph }) => graph.coverage.status === "complete") &&
      input.captures.every(
        ({ inspection }) =>
          inspection.completeness.status === "complete_within_window",
      ),
  };
};

const graphCoverage = (
  input: ReconciledGraphInput,
  facts: GraphCoverageFacts,
  nodeCount: number,
): JavaScriptApplicationGraph["coverage"] =>
  facts.complete
    ? { status: "complete", truncated: false, omitted_count: 0, limits: [] }
    : facts.truncated
      ? {
          status: "partial",
          truncated: true,
          omitted_count: facts.omissionsKnown ? facts.knownOmissions : null,
          limits: [
            ...(facts.inputTruncated
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
          omitted_count: facts.omissionsKnown ? facts.knownOmissions : null,
          limits: [],
        };

const mergeNodes = (
  nodes: readonly ApplicationNode[],
): {
  readonly nodes: ApplicationNode[];
  readonly omittedObservations: number;
} => {
  const grouped = new Map<string, ApplicationNode[]>();
  for (const node of nodes)
    grouped.set(node.node_id, [...(grouped.get(node.node_id) ?? []), node]);
  let omittedObservations = 0;
  const merged = [...grouped.values()].map((group) => {
    const first = group[0];
    if (first === undefined) throw new TypeError("Empty JAG node group");
    if (
      group.some(
        ({ kind, identity }) =>
          kind !== first.kind ||
          JSON.stringify(identity) !== JSON.stringify(first.identity),
      )
    )
      throw new TypeError("Colliding JAG node identifiers disagree");
    const observations = [
      ...new Map(
        group
          .flatMap(({ observations: values }) => values)
          .map((observation) => [observation.observation_id, observation]),
      ).values(),
    ].sort((left, right) =>
      compareCodePoints(left.observation_id, right.observation_id),
    );
    omittedObservations += Math.max(0, observations.length - 64);
    return createJavaScriptApplicationNode({
      kind: first.kind,
      identity: first.identity,
      observations: observations
        .slice(0, 64)
        .map(
          ({ observation_id: _id, identifier_strategy: _strategy, ...value }) =>
            value,
        ),
    });
  });
  return { nodes: merged, omittedObservations };
};

const uniqueEdges = (edges: readonly ApplicationEdge[]): ApplicationEdge[] => [
  ...new Map(edges.map((edge) => [edge.edge_id, edge])).values(),
];

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodePoints);
