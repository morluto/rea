import {
  compareCodePoints,
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  type ApplicationEdge,
  type ApplicationGraphEvidence,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type {
  ApplicationVersionComparisonItem,
  CompareApplicationVersionsInput,
} from "./javascriptApplicationVersionComparisonSchemas.js";

interface ChangeGraphInput {
  readonly left: JavaScriptApplicationGraph;
  readonly right: JavaScriptApplicationGraph;
  readonly leftEvidenceId: string;
  readonly rightEvidenceId: string;
  readonly items: readonly ApplicationVersionComparisonItem[];
  readonly omittedComparisonItems: number;
  readonly limits: CompareApplicationVersionsInput["limits"];
}

/** Bounded cross-version graph and exact projection omission counts. */
export interface ApplicationChangeGraphProjection {
  readonly graph: JavaScriptApplicationGraph;
  readonly omittedNodes: number;
  readonly omittedEdges: number;
  readonly omittedObservations: number;
}

/** Merge compared nodes and add inferred right-to-left changed_from edges. */
export const buildJavaScriptApplicationChangeGraph = (
  input: ChangeGraphInput,
): ApplicationChangeGraphProjection => {
  const allNodes = nodeCandidates(input);
  const preferredRoots = uniqueSorted([
    ...input.right.root_node_ids,
    ...input.left.root_node_ids,
  ]).filter((nodeId) => allNodes.has(nodeId));
  const orderedNodeIds = uniqueSorted([
    ...preferredRoots,
    ...input.items.flatMap(({ left_node_id: left, right_node_id: right }) => [
      ...(right === null ? [] : [right]),
      ...(left === null ? [] : [left]),
    ]),
  ]);
  const retainedIds = orderedNodeIds.slice(0, input.limits.max_graph_nodes);
  const retained = new Set(retainedIds);
  const merged = mergeNodes(
    retainedIds.flatMap((nodeId) => allNodes.get(nodeId) ?? []),
  );
  const sourceEdges = uniqueEdges([
    ...input.left.edges,
    ...input.right.edges,
  ]).filter(
    ({ source_node_id: source, target_node_id: target }) =>
      retained.has(source) && retained.has(target),
  );
  const comparisonEdges = input.items.flatMap((item) =>
    changedFromEdge(item, input, retained),
  );
  const candidateEdges = uniqueEdges([...sourceEdges, ...comparisonEdges]);
  const edges = candidateEdges.slice(0, input.limits.max_graph_edges);
  const omittedNodes = Math.max(0, orderedNodeIds.length - retainedIds.length);
  const omittedEdges = Math.max(0, candidateEdges.length - edges.length);
  const graphOmissions =
    omittedNodes + omittedEdges + merged.omittedObservations;
  const rootNodeIds = preferredRoots
    .filter((nodeId) => retained.has(nodeId))
    .slice(0, 1_000);
  const fallbackRoot = merged.nodes[0]?.node_id;
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    schema_version: 1,
    root_node_ids:
      rootNodeIds.length > 0
        ? rootNodeIds
        : fallbackRoot === undefined
          ? []
          : [fallbackRoot],
    nodes: merged.nodes,
    edges,
    coverage: changeGraphCoverage(input, graphOmissions),
    limitations: uniqueSorted([
      ...input.left.limitations.map((value) => `Left: ${value}`),
      ...input.right.limitations.map((value) => `Right: ${value}`),
      "changed_from edges are cross-version inferences and never promote structural or semantic matches to exact identity.",
      "The change graph contains compared entities and their retained relationships; it is not an executable application.",
      ...(graphOmissions === 0
        ? []
        : ["The change graph omitted content at explicit caller bounds."]),
    ]),
  });
  return {
    graph,
    omittedNodes,
    omittedEdges,
    omittedObservations: merged.omittedObservations,
  };
};

const nodeCandidates = (
  input: ChangeGraphInput,
): Map<string, ApplicationNode[]> => {
  const required = new Set([
    ...input.left.root_node_ids,
    ...input.right.root_node_ids,
    ...input.items.flatMap(({ left_node_id: left, right_node_id: right }) => [
      ...(left === null ? [] : [left]),
      ...(right === null ? [] : [right]),
    ]),
  ]);
  const output = new Map<string, ApplicationNode[]>();
  for (const node of [...input.left.nodes, ...input.right.nodes])
    if (required.has(node.node_id))
      output.set(node.node_id, [...(output.get(node.node_id) ?? []), node]);
  return output;
};

const changedFromEdge = (
  item: ApplicationVersionComparisonItem,
  input: ChangeGraphInput,
  retained: ReadonlySet<string>,
): ApplicationEdge[] => {
  const left = item.left_node_id;
  const right = item.right_node_id;
  if (
    item.match.status !== "matched" ||
    item.status === "unchanged" ||
    left === null ||
    right === null ||
    left === right ||
    !retained.has(left) ||
    !retained.has(right)
  )
    return [];
  const evidence = comparisonEvidence(item, input);
  return [
    createJavaScriptApplicationEdge({
      source_node_id: right,
      target_node_id: left,
      relation: "changed_from",
      properties: {
        comparison_item_id: item.item_id,
        status: item.status,
        match_basis: item.match.basis,
        match_confidence: item.match.confidence,
        dimensions: item.dimensions,
      },
      evidence,
    }),
  ];
};

const comparisonEvidence = (
  item: ApplicationVersionComparisonItem,
  input: ChangeGraphInput,
): ApplicationGraphEvidence => {
  const right = input.right.nodes.find(
    ({ node_id: id }) => id === item.right_node_id,
  );
  const left = input.left.nodes.find(
    ({ node_id: id }) => id === item.left_node_id,
  );
  const source =
    right?.observations[0]?.evidence ?? left?.observations[0]?.evidence;
  const complete =
    input.left.coverage.status === "complete" &&
    input.right.coverage.status === "complete" &&
    input.omittedComparisonItems === 0;
  return {
    authority: "cross-version-comparison",
    state: "inferred",
    confidence: item.match.confidence === "medium" ? "medium" : "high",
    artifact: source?.artifact ?? {
      available: false,
      reason: "unresolved",
      detail: "Compared node has no artifact-backed observation.",
    },
    location: source?.location ?? {
      available: false,
      reason: "unresolved",
      detail: "Compared node has no actionable source location.",
    },
    extractor: {
      name: "rea-application-version-comparison",
      version: "1",
      operation: "compare_application_versions",
      executable_sha256: null,
    },
    coverage: complete
      ? { status: "complete", truncated: false, omitted_count: 0, limits: [] }
      : {
          status: "partial",
          truncated: input.omittedComparisonItems > 0,
          omitted_count:
            input.omittedComparisonItems > 0
              ? input.omittedComparisonItems
              : (source?.coverage.omitted_count ?? null),
          limits:
            input.omittedComparisonItems > 0
              ? [
                  {
                    name: "max-comparison-items",
                    value: input.limits.max_comparison_items,
                    unit: "items",
                  },
                ]
              : [],
        },
    limitations: [
      "Cross-version pairing is inferred from the stated match basis; changed_from does not prove runtime reachability.",
      ...item.limitations,
    ],
    evidence_ids: [input.leftEvidenceId, input.rightEvidenceId],
  };
};

const changeGraphCoverage = (
  input: ChangeGraphInput,
  graphOmissions: number,
): JavaScriptApplicationGraph["coverage"] => {
  const outputOmissions = graphOmissions + input.omittedComparisonItems;
  if (outputOmissions > 0)
    return {
      status: "partial",
      truncated: true,
      omitted_count: outputOmissions,
      limits: [
        {
          name: "max-comparison-items",
          value: input.limits.max_comparison_items,
          unit: "items",
        },
        {
          name: "max-graph-nodes",
          value: input.limits.max_graph_nodes,
          unit: "items",
        },
        {
          name: "max-graph-edges",
          value: input.limits.max_graph_edges,
          unit: "items",
        },
      ],
    };
  if (
    input.left.coverage.status === "complete" &&
    input.right.coverage.status === "complete"
  )
    return {
      status: "complete",
      truncated: false,
      omitted_count: 0,
      limits: [],
    };
  const counts = [
    input.left.coverage.omitted_count,
    input.right.coverage.omitted_count,
  ];
  return {
    status: "partial",
    truncated: false,
    omitted_count: counts.every((value) => value !== null)
      ? counts.reduce<number>((total, value) => total + (value ?? 0), 0)
      : null,
    limits: [],
  };
};

const mergeNodes = (
  nodes: readonly ApplicationNode[],
): {
  readonly nodes: ApplicationNode[];
  readonly omittedObservations: number;
} => {
  const groups = new Map<string, ApplicationNode[]>();
  for (const node of nodes)
    groups.set(node.node_id, [...(groups.get(node.node_id) ?? []), node]);
  let omittedObservations = 0;
  const merged = [...groups.values()].map((group) => {
    const first = group[0];
    if (first === undefined)
      throw new TypeError("Empty change-graph node group");
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
  return {
    nodes: merged.sort((left, right) =>
      compareCodePoints(left.node_id, right.node_id),
    ),
    omittedObservations,
  };
};

const uniqueEdges = (edges: readonly ApplicationEdge[]): ApplicationEdge[] =>
  [...new Map(edges.map((edge) => [edge.edge_id, edge])).values()].sort(
    (left, right) => compareCodePoints(left.edge_id, right.edge_id),
  );

const uniqueSorted = <Value extends string>(
  values: readonly Value[],
): Value[] => [...new Set(values)].sort(compareCodePoints);
