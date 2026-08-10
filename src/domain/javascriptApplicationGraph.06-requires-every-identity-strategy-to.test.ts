import { describe, expect, it } from "vitest";

import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  type ApplicationGraphEvidence,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  artifactEvidence,
  inferredArtifactEvidence,
  runtimeEvidence,
} from "./javascriptApplicationGraph.fixture.js";

const completeCoverage = {
  status: "complete" as const,
  truncated: false,
  omitted_count: 0,
  limits: [],
};

const unknownEvidence = (
  limitations: string[] = ["The extractor could not classify this fact."],
): ApplicationGraphEvidence => ({
  authority: "unknown",
  state: "unknown",
  confidence: "unknown",
  artifact: {
    available: false,
    reason: "unknown",
    detail: "Artifact provenance is unknown.",
  },
  location: {
    available: false,
    reason: "unknown",
    detail: "Source location is unknown.",
  },
  extractor: {
    name: "test",
    version: "1",
    operation: "unknown",
    executable_sha256: null,
  },
  coverage: {
    status: "unknown",
    truncated: false,
    omitted_count: null,
    limits: [],
  },
  limitations,
  evidence_ids: [],
});

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

const contentNode = (
  evidence: ApplicationGraphEvidence,
  properties: Record<string, unknown> = {},
): ApplicationNode =>
  createJavaScriptApplicationNode({
    kind: "javascript-module",
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: APPLICATION_GRAPH_DIGESTS.asar,
    },
    observations: [{ label: "module", properties, evidence }],
  });

describe("JavaScript Application Graph", () => {
  it("requires every identity strategy to have compatible supporting evidence", () => {
    const mismatchedPath = createJavaScriptApplicationNode({
      kind: "javascript-asset",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        path: "dist/expected.js",
      },
      observations: [
        {
          label: null,
          properties: {},
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/other.js",
          ),
        },
      ],
    });
    expect(() => graphForNode(mismatchedPath)).toThrow(
      /identity is not supported/u,
    );

    const runtimeWithStaticEvidence = createJavaScriptApplicationNode({
      kind: "runtime-script-instance",
      identity: {
        strategy: "runtime-instance",
        stability: "capture-only",
        capture_sha256: APPLICATION_GRAPH_DIGESTS.capture,
        runtime_key: "script-preload",
      },
      observations: [
        {
          label: null,
          properties: {},
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/preload.js",
            "ast-static-analysis",
          ),
        },
      ],
    });
    expect(() => graphForNode(runtimeWithStaticEvidence)).toThrow(
      /identity is not supported/u,
    );

    const mismatchedDigest = contentNode(
      artifactEvidence("7".repeat(64), "dist/module.js"),
    );
    expect(() => graphForNode(mismatchedDigest)).toThrow(
      /identity is not supported/u,
    );
  });

  it("prevents static authorities from claiming runtime locations", () => {
    const evidence = artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
      "ast-static-analysis",
    );
    evidence.location = runtimeEvidence("script-module").location;
    expect(() => graphForNode(contentNode(evidence))).toThrow(
      /cannot claim a runtime location/u,
    );
  });

  it("enforces epistemic truthfulness and content-addressed artifacts", () => {
    const inferredAsObserved = inferredArtifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    inferredAsObserved.state = "observed";
    inferredAsObserved.confidence = "exact";
    expect(() => contentNode(inferredAsObserved)).toThrow(
      /must remain inferred/u,
    );

    const inferenceWithoutLimit = inferredArtifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    inferenceWithoutLimit.limitations = [];
    expect(() => contentNode(inferenceWithoutLimit)).toThrow(
      /Inferred facts require an explicit limitation/u,
    );

    const unknownWithoutLimit = unknownEvidence([]);
    expect(() => contentNode(unknownWithoutLimit)).toThrow(
      /require unknown confidence and an explicit limitation/u,
    );

    const missingArtifact = artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    missingArtifact.artifact = {
      available: false,
      reason: "not-observed",
      detail: "Bytes were not observed.",
    };
    expect(() => contentNode(missingArtifact)).toThrow(
      /require a content digest/u,
    );

    const mismatchedArtifact = artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    if (mismatchedArtifact.artifact.available)
      mismatchedArtifact.artifact.artifact_id = `art_${"8".repeat(64)}`;
    expect(() => contentNode(mismatchedArtifact)).toThrow(
      /same SHA-256 digest/u,
    );

    const unlocatedObservation = artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    unlocatedObservation.location = {
      available: false,
      reason: "not-observed",
      detail: "The exact location was not recorded.",
    };
    expect(() => contentNode(unlocatedObservation)).toThrow(
      /Observed facts require an actionable location/u,
    );
  });
});
