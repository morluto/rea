import { describe, expect, it } from "vitest";

import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  parseJavaScriptApplicationGraph,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  artifactEvidence,
  buildSyntheticJavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.fixture.js";

const completeCoverage = {
  status: "complete" as const,
  truncated: false,
  omitted_count: 0,
  limits: [],
};

const firstOf = <Value>(values: readonly Value[], label: string): Value => {
  const value = values[0];
  if (value === undefined) throw new TypeError(`Missing fixture ${label}`);
  return value;
};

const graphForNode = (node: ApplicationNode): JavaScriptApplicationGraph =>
  createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    schema_version: 1,
    root_node_ids: [node.node_id],
    nodes: [node],
    edges: [],
    coverage: completeCoverage,
    limitations: [],
  });

describe("JavaScript Application Graph", () => {
  it("admits source-map and observation-scoped identities only with supporting observations", () => {
    const sourceModule = createJavaScriptApplicationNode({
      kind: "source-module",
      identity: {
        strategy: "source-map-original",
        stability: "source-map-exact",
        source_map_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        original_source: "webpack:///src/editor.ts",
        source_sha256: null,
      },
      observations: [
        {
          label: "src/editor.ts",
          properties: { recovered_from: "source-map" },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/app.js.map",
            "ast-static-analysis",
          ),
        },
      ],
    });
    const observationScoped = createJavaScriptApplicationNode({
      kind: "unknown",
      identity: {
        strategy: "observation-fingerprint",
        stability: "observation-only",
        observation_sha256: "8".repeat(64),
        scope: "synthetic static inventory",
      },
      observations: [
        {
          label: "unclassified entity",
          properties: {},
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/app.js",
          ),
        },
      ],
    });

    expect(graphForNode(sourceModule).nodes).toEqual([sourceModule]);
    expect(graphForNode(observationScoped).nodes).toEqual([observationScoped]);
  });

  it("rejects unsupported versions, unknown fields, and stale commitments", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    expect(() =>
      parseJavaScriptApplicationGraph({ ...graph, schema_version: 2 }),
    ).toThrow(/Unsupported JavaScript Application Graph schema version: 2/u);
    expect(() =>
      parseJavaScriptApplicationGraph({ ...graph, surprise: true }),
    ).toThrow();

    const staleGraph = structuredClone(graph);
    staleGraph.graph_id = `jag_${"f".repeat(64)}`;
    expect(() => parseJavaScriptApplicationGraph(staleGraph)).toThrow(
      /Graph identifier/u,
    );

    const staleNode = structuredClone(graph);
    firstOf(staleNode.nodes, "node").node_id = `jag_node_${"f".repeat(64)}`;
    expect(() => parseJavaScriptApplicationGraph(staleNode)).toThrow(
      /Node identifier/u,
    );

    const staleObservation = structuredClone(graph);
    firstOf(
      firstOf(staleObservation.nodes, "node").observations,
      "observation",
    ).observation_id = `jag_observation_${"f".repeat(64)}`;
    expect(() => parseJavaScriptApplicationGraph(staleObservation)).toThrow(
      /Observation identifier/u,
    );

    const staleEdge = structuredClone(graph);
    firstOf(staleEdge.edges, "edge").edge_id = `jag_edge_${"f".repeat(64)}`;
    expect(() => parseJavaScriptApplicationGraph(staleEdge)).toThrow(
      /Edge identifier/u,
    );
  });
});
