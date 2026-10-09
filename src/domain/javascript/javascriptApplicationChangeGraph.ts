import {
  createJavaScriptApplicationEdge,
  createImmutableJavaScriptApplicationGraphSteps,
  createJavaScriptApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type {
  ApplicationEdge,
  ApplicationNode,
} from "./javascriptApplicationGraphSchemas.js";
import type { ApplicationGraphEvidence } from "./javascriptApplicationEvidenceSchemas.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { ApplicationVersionComparisonItem } from "./javascriptApplicationVersionComparisonSchemas.js";

interface ChangeGraphInput {
  readonly left: JavaScriptApplicationGraph;
  readonly right: JavaScriptApplicationGraph;
  readonly leftEvidenceId: string;
  readonly rightEvidenceId: string;
  readonly items: readonly ApplicationVersionComparisonItem[];
}

/** Complete cross-version graph projection. */
export interface ApplicationChangeGraphProjection {
  readonly graph: JavaScriptApplicationGraph;
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
  const retained = new Set(orderedNodeIds);
  const mergedNodes = mergeNodes(
    orderedNodeIds.flatMap((nodeId) => allNodes.get(nodeId) ?? []),
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
  const rootNodeIds = preferredRoots.filter((nodeId) => retained.has(nodeId));
  const fallbackRoot = mergedNodes[0]?.node_id;
  const steps = createImmutableJavaScriptApplicationGraphSteps({
    schema: "JavaScriptApplicationGraph",
    root_node_ids:
      rootNodeIds.length > 0
        ? rootNodeIds
        : fallbackRoot === undefined
          ? []
          : [fallbackRoot],
    nodes: mergedNodes,
    edges: candidateEdges,
    coverage: changeGraphCoverage(input),
    limitations: uniqueSorted([
      ...input.left.limitations.map((value) => `Left: ${value}`),
      ...input.right.limitations.map((value) => `Right: ${value}`),
      "changed_from edges are cross-version inferences and never promote structural or semantic matches to exact identity.",
      "The change graph contains compared entities and their retained relationships; it is not an executable application.",
    ]),
  });
  let next = steps.next();
  while (!next.done) next = steps.next();
  return { graph: next.value };
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
    input.right.coverage.status === "complete";
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
          truncated:
            input.left.coverage.truncated || input.right.coverage.truncated,
          omitted_count: combineOmittedCounts(
            input.left.coverage.omitted_count,
            input.right.coverage.omitted_count,
          ),
          limits: sourceCoverageLimits(input),
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
): JavaScriptApplicationGraph["coverage"] => {
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
  return {
    status: "partial",
    truncated: input.left.coverage.truncated || input.right.coverage.truncated,
    omitted_count: combineOmittedCounts(
      input.left.coverage.omitted_count,
      input.right.coverage.omitted_count,
    ),
    limits: sourceCoverageLimits(input),
  };
};

const sourceCoverageLimits = (input: ChangeGraphInput) =>
  [
    ...new Map(
      [...input.left.coverage.limits, ...input.right.coverage.limits].map(
        (limit) => [`${limit.name}\0${limit.value}\0${limit.unit}`, limit],
      ),
    ).values(),
  ].sort((left, right) => compareUnicodeCodePoints(left.name, right.name));

const combineOmittedCounts = (left: number | null, right: number | null) =>
  left === null || right === null ? null : left + right;

const mergeNodes = (nodes: readonly ApplicationNode[]): ApplicationNode[] => {
  const groups = new Map<string, ApplicationNode[]>();
  for (const node of nodes)
    groups.set(node.node_id, [...(groups.get(node.node_id) ?? []), node]);
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
      compareUnicodeCodePoints(left.observation_id, right.observation_id),
    );
    return createJavaScriptApplicationNode({
      kind: first.kind,
      identity: first.identity,
      observations: observations.map(
        ({ observation_id: _id, identifier_strategy: _strategy, ...value }) =>
          value,
      ),
    });
  });
  return merged.sort((left, right) =>
    compareUnicodeCodePoints(left.node_id, right.node_id),
  );
};

const uniqueEdges = (edges: readonly ApplicationEdge[]): ApplicationEdge[] =>
  [...new Map(edges.map((edge) => [edge.edge_id, edge])).values()].sort(
    (left, right) => compareUnicodeCodePoints(left.edge_id, right.edge_id),
  );
