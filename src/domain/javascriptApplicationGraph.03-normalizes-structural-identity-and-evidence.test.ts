import { describe, expect, it } from "vitest";

import {
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
  runtimeEvidence,
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
  it("normalizes structural identity and evidence set ordering", () => {
    const evidence = inferredArtifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    evidence.limitations = ["z limitation", "a limitation", "a limitation"];
    evidence.evidence_ids = [
      `ev_${"b".repeat(64)}`,
      `ev_${"a".repeat(64)}`,
      `ev_${"a".repeat(64)}`,
    ];
    evidence.coverage.limits = [
      { name: "modules", value: 100, unit: "items" },
      { name: "modules", value: 100, unit: "items" },
    ];
    const node = createJavaScriptApplicationNode({
      kind: "javascript-module",
      identity: {
        strategy: "structural-fingerprint",
        stability: "cross-version-inference",
        algorithm: "synthetic-v1",
        fingerprint_sha256: "5".repeat(64),
        basis: ["syntax-tree", "imports", "syntax-tree"],
      },
      observations: [{ label: "module", properties: {}, evidence }],
    });

    expect(node.identity).toMatchObject({ basis: ["imports", "syntax-tree"] });
    expect(node.observations[0]?.evidence.limitations).toEqual([
      "a limitation",
      "z limitation",
    ]);
    expect(node.observations[0]?.evidence.evidence_ids).toEqual([
      `ev_${"a".repeat(64)}`,
      `ev_${"b".repeat(64)}`,
    ]);
    expect(node.observations[0]?.evidence.coverage.limits).toEqual([
      { name: "modules", value: 100, unit: "items" },
    ]);
    expect(graphForNode(node).nodes).toEqual([node]);
  });

  it("scopes runtime identities to a capture and artifact paths to a version", () => {
    const runtime = nodeByLabel(
      buildSyntheticJavaScriptApplicationGraph(),
      "preload runtime script",
    );
    const differentCapture = createJavaScriptApplicationNode({
      kind: "runtime-script-instance",
      identity: {
        strategy: "runtime-instance",
        stability: "capture-only",
        capture_sha256: "6".repeat(64),
        runtime_key: "script-preload",
      },
      observations: [
        {
          label: "other capture",
          properties: {},
          evidence: {
            ...runtimeEvidence("script-preload"),
            location: {
              available: true,
              value: {
                kind: "runtime",
                capture_sha256: "6".repeat(64),
                target_key: "target-main",
                frame_key: "frame-main",
                script_key: "script-preload",
              },
            },
          },
        },
      ],
    });
    expect(differentCapture.node_id).not.toBe(runtime.node_id);

    const firstArtifact = createJavaScriptApplicationNode({
      kind: "javascript-asset",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        path: "dist/app.js",
      },
      observations: [
        {
          label: null,
          properties: {},
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/app.js",
          ),
        },
      ],
    });
    const secondArtifact = createJavaScriptApplicationNode({
      kind: "javascript-asset",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: "7".repeat(64),
        path: "dist/app.js",
      },
      observations: [
        {
          label: null,
          properties: {},
          evidence: artifactEvidence("7".repeat(64), "dist/app.js"),
        },
      ],
    });
    expect(firstArtifact.node_id).not.toBe(secondArtifact.node_id);
  });
});
