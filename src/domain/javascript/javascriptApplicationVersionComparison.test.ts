import { describe, expect, it } from "vitest";

import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  isValidatedImmutableJavaScriptApplicationGraph,
  parseJavaScriptApplicationGraph,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import {
  artifactEvidence,
  completeCoverage,
} from "./javascriptApplicationGraph.fixture.js";
import { compareJavaScriptApplicationVersions } from "./javascriptApplicationVersionComparison.js";
import {
  applicationVersionComparisonResultSchema,
  ownedApplicationVersionComparisonResultSchema,
} from "./javascriptApplicationVersionComparisonSchemas.js";

const LEFT_SHA = "a".repeat(64);
const RIGHT_SHA = "b".repeat(64);

const buildGraph = (
  artifactSha: string,
  version: number,
): JavaScriptApplicationGraph => {
  const nodes = ["a", "b", "c"].map((name) =>
    createJavaScriptApplicationNode({
      kind: "javascript-module",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: artifactSha,
        path: `${name}.js`,
      },
      observations: [
        {
          label: `${name}.js`,
          properties: {
            structural_fingerprint_sha256: name
              .charCodeAt(0)
              .toString(16)
              .padStart(64, "0"),
            structural_fingerprint_algorithm: "fixture",
            source_sha256: (name === "b" ? version : 0)
              .toString(16)
              .padStart(64, "0"),
          },
          evidence: artifactEvidence(artifactSha, `${name}.js`),
        },
      ],
    }),
  );
  const [a, b, c] = nodes;
  if (a === undefined || b === undefined || c === undefined)
    throw new Error("Missing fixture node");
  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [a.node_id],
    nodes,
    edges: [
      createJavaScriptApplicationEdge({
        source_node_id: a.node_id,
        target_node_id: b.node_id,
        relation: "imports",
        properties: {},
        evidence: artifactEvidence(artifactSha, "a.js"),
      }),
      createJavaScriptApplicationEdge({
        source_node_id: b.node_id,
        target_node_id: c.node_id,
        relation: "imports",
        properties: {},
        evidence: artifactEvidence(artifactSha, "b.js"),
      }),
    ],
    coverage: completeCoverage,
    limitations: [],
  });
};

const compare = () =>
  compareJavaScriptApplicationVersions({
    left: {
      evidenceId: `ev_${"1".repeat(64)}`,
      rootArtifactSha256: LEFT_SHA,
      graph: buildGraph(LEFT_SHA, 1),
    },
    right: {
      evidenceId: `ev_${"2".repeat(64)}`,
      rootArtifactSha256: RIGHT_SHA,
      graph: buildGraph(RIGHT_SHA, 2),
    },
    leftNativeEvidence: [],
    rightNativeEvidence: [],
  });

describe("application version comparison result", () => {
  it("returns a sealed change graph that passes complete validation", () => {
    const result = compare();
    expect(
      result.graph.edges.some(({ relation }) => relation === "changed_from"),
    ).toBe(true);
    expect(isValidatedImmutableJavaScriptApplicationGraph(result.graph)).toBe(
      true,
    );
    expect(Object.isFrozen(result.graph.edges)).toBe(true);
    expect(parseJavaScriptApplicationGraph(result.graph)).toEqual(result.graph);
    expect(applicationVersionComparisonResultSchema.parse(result)).toEqual(
      result,
    );
  });

  it("does not reuse a change graph without an owned proof", () => {
    const result = compare();
    const copy = structuredClone(result.graph);
    expect(isValidatedImmutableJavaScriptApplicationGraph(copy)).toBe(false);
    expect(() =>
      ownedApplicationVersionComparisonResultSchema.parse({
        ...result,
        graph: copy,
      }),
    ).toThrow();
    expect(
      applicationVersionComparisonResultSchema.parse({ ...result, graph: copy })
        .graph,
    ).toEqual(result.graph);
  });

  it("keeps coverage validation for owned results", () => {
    const result = compare();
    expect(() =>
      ownedApplicationVersionComparisonResultSchema.parse({
        ...result,
        coverage: { ...result.coverage, status: "partial" },
      }),
    ).toThrow("Comparison coverage must match source graph completeness");
  });
});
