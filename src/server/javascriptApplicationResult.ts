import type { Evidence } from "../domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../domain/javascriptApplicationAnalysis.js";
import { compareCodePoints } from "../domain/javascriptApplicationGraph.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { javascriptApplicationAnalysisSummarySchema } from "../contracts/electronToolContracts.js";

const DEFAULT_GRAPH_PAGE_LIMIT = 100;
const ROOT_SAMPLE_LIMIT = 10;
const TOP_FINDING_LIMIT = 20;

const FINDING_PRIORITY: Readonly<Record<string, number>> = {
  "browser-window": 0,
  "electron-preload": 1,
  "context-bridge-api": 2,
  "ipc-channel": 3,
  "ipc-handler": 4,
  "electron-utility": 5,
  endpoint: 6,
  storage: 7,
  worker: 8,
  "service-worker": 9,
  "native-addon": 10,
  "native-export": 11,
  "source-map": 12,
};

/** Project complete JavaScript application Evidence into a bounded agent result. */
export const summarizeJavaScriptApplicationEvidence = (
  evidence: Evidence,
): JsonValue => {
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  const nodeKinds = new Map<string, number>();
  for (const node of result.graph.nodes)
    nodeKinds.set(node.kind, (nodeKinds.get(node.kind) ?? 0) + 1);
  const rootItems = result.graph.root_node_ids.slice(0, ROOT_SAMPLE_LIMIT);
  const pageRoot = `rea://evidence/${evidence.evidence_id}/application-graph`;
  const topFindings = [...result.graph.nodes]
    .sort(
      (left, right) =>
        (FINDING_PRIORITY[left.kind] ?? Number.MAX_SAFE_INTEGER) -
          (FINDING_PRIORITY[right.kind] ?? Number.MAX_SAFE_INTEGER) ||
        compareCodePoints(left.node_id, right.node_id),
    )
    .slice(0, TOP_FINDING_LIMIT)
    .map((node) => {
      const observation = node.observations[0];
      if (observation === undefined)
        throw new TypeError("Application graph node has no observation");
      return {
        node_id: node.node_id,
        kind: node.kind,
        label: observation.label,
        authority: observation.evidence.authority,
        state: observation.evidence.state,
        confidence: observation.evidence.confidence,
        location: observation.evidence.location,
      };
    });
  const summary =
    result.schema_version === 1 ? omitGraph(result) : omitGraphs(result);
  const unknowns = new Set([
    ...result.limitations,
    ...result.graph.limitations,
  ]);
  if (result.statistics.parse_failures > 0)
    unknowns.add(
      `${String(result.statistics.parse_failures)} JavaScript file(s) could not be parsed.`,
    );
  if (result.statistics.truncated_scopes > 0)
    unknowns.add(
      `${String(result.statistics.truncated_scopes)} analysis scope(s) were truncated.`,
    );
  if (result.graph.coverage.status !== "complete")
    unknowns.add(
      `Application graph coverage is ${result.graph.coverage.status}; omitted facts remain unknown.`,
    );
  return javascriptApplicationAnalysisSummarySchema.parse({
    ...summary,
    ...(result.schema_version === 1
      ? {}
      : {
          semantic_graph: {
            graph_id: result.semantic_graph.graph_id,
            nodes: result.semantic_graph.nodes.length,
            relations: result.semantic_graph.relations.length,
            unknown_frontiers: result.semantic_graph.unknowns.length,
            fingerprints: result.semantic_graph.fingerprints.length,
            coverage: result.semantic_graph.coverage.status,
            query_tool: "trace_javascript_semantics",
          },
        }),
    unknowns: [...unknowns],
    graph: {
      graph_id: result.graph.graph_id,
      node_count: result.graph.nodes.length,
      edge_count: result.graph.edges.length,
      roots: {
        items: rootItems,
        total: result.graph.root_node_ids.length,
        truncated: rootItems.length < result.graph.root_node_ids.length,
      },
      node_kinds: [...nodeKinds]
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([kind, count]) => ({ kind, count })),
      top_findings: topFindings,
      coverage: result.graph.coverage,
      limitations: result.graph.limitations,
      pages: {
        nodes: `${pageRoot}/nodes/offset/0/limit/${String(DEFAULT_GRAPH_PAGE_LIMIT)}`,
        edges: `${pageRoot}/edges/offset/0/limit/${String(DEFAULT_GRAPH_PAGE_LIMIT)}`,
        page_limit: DEFAULT_GRAPH_PAGE_LIMIT,
      },
    },
  });
};

const omitGraph = (
  result: Extract<
    ReturnType<typeof javascriptApplicationAnalysisResultSchema.parse>,
    { readonly schema_version: 1 }
  >,
) => {
  const { graph: _graph, ...summary } = result;
  return summary;
};

const omitGraphs = (
  result: Extract<
    ReturnType<typeof javascriptApplicationAnalysisResultSchema.parse>,
    { readonly schema_version: 2 }
  >,
) => {
  const { graph: _graph, semantic_graph: _semanticGraph, ...summary } = result;
  return summary;
};
