import { describe, expect, it } from "vitest";

import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  artifactEvidence,
  buildSyntheticJavaScriptApplicationGraph,
  inferredArtifactEvidence,
} from "./javascriptApplicationGraph.fixture.js";

const completeCoverage = {
  status: "complete" as const,
  truncated: false,
  omitted_count: 0,
  limits: [],
};

const nodeByLabel = (
  graph: JavaScriptApplicationGraph,
  label: string,
): ApplicationNode => {
  const node = graph.nodes.find(({ observations }) =>
    observations.some((observation) => observation.label === label),
  );
  if (node === undefined) throw new TypeError(`Missing fixture node: ${label}`);
  return node;
};

const firstOf = <Value>(values: readonly Value[], label: string): Value => {
  const value = values[0];
  if (value === undefined) throw new TypeError(`Missing fixture ${label}`);
  return value;
};

describe("JavaScript Application Graph", () => {
  it("rejects duplicate nodes, missing roots, dangling edges, and self edges", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const { graph_id: _graphId, ...semantic } = graph;
    const source = firstOf(semantic.nodes, "node");
    expect(() =>
      createJavaScriptApplicationGraph({
        ...semantic,
        nodes: [...semantic.nodes, source],
      }),
    ).toThrow(/Nodes must be sorted and unique/u);
    expect(() =>
      createJavaScriptApplicationGraph({
        ...semantic,
        root_node_ids: [`jag_node_${"9".repeat(64)}`],
      }),
    ).toThrow(/Root identifier/u);

    const missingId = `jag_node_${"9".repeat(64)}`;
    const dangling = createJavaScriptApplicationEdge({
      source_node_id: source.node_id,
      target_node_id: missingId,
      relation: "loads",
      properties: {},
      evidence: inferredArtifactEvidence(
        APPLICATION_GRAPH_DIGESTS.asar,
        "dist/main.js",
      ),
    });
    expect(() =>
      createJavaScriptApplicationGraph({
        ...semantic,
        edges: [...semantic.edges, dangling],
      }),
    ).toThrow(/endpoints must name graph nodes/u);

    const selfEdge = createJavaScriptApplicationEdge({
      source_node_id: source.node_id,
      target_node_id: source.node_id,
      relation: "imports",
      properties: {},
      evidence: inferredArtifactEvidence(
        APPLICATION_GRAPH_DIGESTS.asar,
        "dist/main.js",
      ),
    });
    expect(() =>
      createJavaScriptApplicationGraph({
        ...semantic,
        edges: [...semantic.edges, selfEdge],
      }),
    ).toThrow(/self-referential/u);
  });

  it("allows changed_from only between entities of the same kind", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const preload = nodeByLabel(graph, "desktop preload");
    const runtime = nodeByLabel(graph, "preload runtime script");
    const earlierPreload = createJavaScriptApplicationNode({
      kind: "electron-preload",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: "7".repeat(64),
        path: "dist/preload.js",
      },
      observations: [
        {
          label: "earlier preload",
          properties: {},
          evidence: artifactEvidence("7".repeat(64), "dist/preload.js"),
        },
      ],
    });
    const changedFrom = createJavaScriptApplicationEdge({
      source_node_id: preload.node_id,
      target_node_id: earlierPreload.node_id,
      relation: "changed_from",
      properties: {},
      evidence: inferredArtifactEvidence(
        APPLICATION_GRAPH_DIGESTS.asar,
        "dist/preload.js",
      ),
    });
    expect(
      createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        schema_version: 1,
        root_node_ids: [preload.node_id],
        nodes: [preload, earlierPreload],
        edges: [changedFrom],
        coverage: completeCoverage,
        limitations: [],
      }).edges,
    ).toEqual([changedFrom]);

    const invalid = createJavaScriptApplicationEdge({
      source_node_id: preload.node_id,
      target_node_id: runtime.node_id,
      relation: "changed_from",
      properties: {},
      evidence: inferredArtifactEvidence(
        APPLICATION_GRAPH_DIGESTS.asar,
        "dist/preload.js",
      ),
    });
    expect(() =>
      createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        schema_version: 1,
        root_node_ids: [preload.node_id],
        nodes: [preload, runtime],
        edges: [invalid],
        coverage: completeCoverage,
        limitations: [],
      }),
    ).toThrow(/changed_from endpoints must have the same node kind/u);
  });
});
