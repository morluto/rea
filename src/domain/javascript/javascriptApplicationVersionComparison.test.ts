import { unknownTarget } from "../targetIdentity.js";
import { describe, expect, it } from "vitest";

import { createEvidence } from "../evidence.js";
import type { JsonValue } from "../jsonValue.js";
import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
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

const unrelatedNode = (artifactSha: string) =>
  createJavaScriptApplicationNode({
    kind: "javascript-chunk",
    identity: {
      strategy: "canonical-path",
      stability: "artifact-version",
      artifact_sha256: artifactSha,
      path: "unrelated.js",
    },
    observations: [
      {
        label: "unrelated.js",
        properties: {},
        evidence: artifactEvidence(artifactSha, "unrelated.js"),
      },
    ],
  });

const nativeEvidence = (sha256: string | undefined, ordinal: number) =>
  createEvidence(
    sha256 === undefined
      ? unknownTarget("not-observed")
      : {
          path: `/fixture/native-${ordinal}.js`,
          sha256,
          format: "javascript",
        },
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "analyze_javascript_module",
      parameters: { ordinal },
      confidence: "observed",
      authority: "shipped-artifact",
      result: { ordinal },
    },
  );

const occurrenceGraph = (
  rootSha256: string,
  occurrence: JsonValue,
): JavaScriptApplicationGraph => {
  const sourceSha256 = "c".repeat(64);
  const module = createJavaScriptApplicationNode({
    kind: "javascript-module",
    identity: {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: sourceSha256,
      namespace: "source-module",
      key: `${rootSha256}:main.js`,
    },
    observations: [
      {
        label: "main.js",
        properties: {
          semantic_role: "source-module",
          source_sha256: sourceSha256,
          file_occurrence: occurrence,
        },
        evidence: artifactEvidence(sourceSha256, "main.js"),
      },
    ],
  });
  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [module.node_id],
    nodes: [module],
    edges: [],
    coverage: completeCoverage,
    limitations: [],
  });
};

const occurrenceDifferences: readonly {
  readonly name: string;
  readonly leftOccurrence: JsonValue;
  readonly rightOccurrence: JsonValue;
}[] = [
  {
    name: "path",
    leftOccurrence: {
      container_sha256: LEFT_SHA,
      path: "main.js",
      sha256: "c".repeat(64),
    },
    rightOccurrence: {
      container_sha256: RIGHT_SHA,
      path: "moved.js",
      sha256: "c".repeat(64),
    },
  },
  {
    name: "content digest",
    leftOccurrence: {
      container_sha256: LEFT_SHA,
      path: "main.js",
      sha256: "c".repeat(64),
    },
    rightOccurrence: {
      container_sha256: RIGHT_SHA,
      path: "main.js",
      sha256: "d".repeat(64),
    },
  },
  {
    name: "noncanonical data",
    leftOccurrence: { container_sha256: LEFT_SHA },
    rightOccurrence: { container_sha256: RIGHT_SHA },
  },
];

it.each(occurrenceDifferences)(
  "keeps occurrence $name differences visible without altering source evidence",
  ({ leftOccurrence, rightOccurrence }) => {
    const left = occurrenceGraph(LEFT_SHA, leftOccurrence);
    const right = occurrenceGraph(RIGHT_SHA, rightOccurrence);
    const original = JSON.stringify([left, right]);
    const result = compareJavaScriptApplicationVersions({
      left: {
        evidenceId: `ev_${"1".repeat(64)}`,
        rootArtifactSha256: LEFT_SHA,
        graph: left,
      },
      right: {
        evidenceId: `ev_${"2".repeat(64)}`,
        rootArtifactSha256: RIGHT_SHA,
        graph: right,
      },
      leftNativeEvidence: [],
      rightNativeEvidence: [],
    });

    expect(result.items).toMatchObject([
      {
        status: "changed",
        match: { basis: "exact-module-source-digest", confidence: "exact" },
        dimensions: ["properties"],
      },
    ]);
    expect(JSON.stringify([left, right])).toBe(original);
    expect(left.nodes[0]?.observations[0]?.properties.file_occurrence).toEqual(
      leftOccurrence,
    );
    expect(right.nodes[0]?.observations[0]?.properties.file_occurrence).toEqual(
      rightOccurrence,
    );
    expect(left.nodes[0]?.observations[0]?.evidence).toEqual(
      right.nodes[0]?.observations[0]?.evidence,
    );
  },
);

it("attributes native Evidence to exact observations on the owning side", () => {
  const left = buildGraph(LEFT_SHA, 1);
  const fullRight = buildGraph(RIGHT_SHA, 2);
  const byLabel = (graph: JavaScriptApplicationGraph, label: string) => {
    const node = graph.nodes.find(({ observations }) =>
      observations.some((value) => value.label === label),
    );
    if (node === undefined) throw new Error(`Missing fixture node ${label}`);
    return node;
  };
  const leftA = byLabel(left, "a.js");
  const leftB = byLabel(left, "b.js");
  const rightA = byLabel(fullRight, "a.js");
  const rightB = byLabel(fullRight, "b.js");
  const unrelated = unrelatedNode(RIGHT_SHA);
  const { graph_id: _graphId, ...rightInput } = fullRight;
  const right = createJavaScriptApplicationGraph({
    ...rightInput,
    nodes: [
      ...fullRight.nodes.filter(({ node_id }) => node_id !== rightB.node_id),
      unrelated,
    ],
    edges: fullRight.edges.filter(
      ({ source_node_id, target_node_id }) =>
        source_node_id !== rightB.node_id && target_node_id !== rightB.node_id,
    ),
  });
  const leftEvidenceId = `ev_${"1".repeat(64)}`;
  const rightEvidenceId = `ev_${"2".repeat(64)}`;
  const parents = [leftEvidenceId, rightEvidenceId];
  const bDigest = `${"0".repeat(63)}1`;
  const leftNativeA = nativeEvidence("0".repeat(64), 1);
  const leftNativeB = nativeEvidence(bDigest, 2);
  const leftNativeB2 = nativeEvidence(bDigest, 3);
  const rightNativeA = nativeEvidence("0".repeat(64), 4);
  const result = compareJavaScriptApplicationVersions({
    left: {
      evidenceId: leftEvidenceId,
      rootArtifactSha256: LEFT_SHA,
      graph: left,
    },
    right: {
      evidenceId: rightEvidenceId,
      rootArtifactSha256: RIGHT_SHA,
      graph: right,
    },
    leftNativeEvidence: [leftNativeA, leftNativeB, leftNativeB2],
    rightNativeEvidence: [
      rightNativeA,
      nativeEvidence(bDigest, 5),
      nativeEvidence(undefined, 6),
    ],
  });
  expect(
    result.items.find(({ left_node_id }) => left_node_id === leftA.node_id),
  ).toMatchObject({
    right_node_id: rightA.node_id,
    match: { status: "matched" },
    evidence_links: [
      ...parents,
      leftNativeA.evidence_id,
      rightNativeA.evidence_id,
    ].sort(),
  });
  expect(
    result.items.find(({ left_node_id }) => left_node_id === leftB.node_id),
  ).toMatchObject({
    right_node_id: null,
    status: "removed",
    evidence_links: [
      ...parents,
      leftNativeB.evidence_id,
      leftNativeB2.evidence_id,
    ].sort(),
  });
  expect(
    result.items.find(
      ({ right_node_id }) => right_node_id === unrelated.node_id,
    ),
  ).toMatchObject({
    left_node_id: null,
    status: "added",
    evidence_links: parents.sort(),
  });
});

describe("application version comparison graph ownership", () => {
  it("retains deduplicated complete input limits on the change graph and inferred edge", () => {
    const leftLimits = [
      { name: "modules", value: 100, unit: "items" as const },
    ];
    const rightLimits = [
      { name: "source-bytes", value: 4096, unit: "bytes" as const },
      { name: "modules", value: 100, unit: "items" as const },
    ];
    const withLimits = (
      graph: JavaScriptApplicationGraph,
      limits: JavaScriptApplicationGraph["coverage"]["limits"],
    ): JavaScriptApplicationGraph => {
      const { graph_id: _graphId, ...input } = graph;
      return createJavaScriptApplicationGraph({
        ...input,
        coverage: { ...graph.coverage, limits },
      });
    };
    const result = compareJavaScriptApplicationVersions({
      left: {
        evidenceId: `ev_${"1".repeat(64)}`,
        rootArtifactSha256: LEFT_SHA,
        graph: withLimits(buildGraph(LEFT_SHA, 1), leftLimits),
      },
      right: {
        evidenceId: `ev_${"2".repeat(64)}`,
        rootArtifactSha256: RIGHT_SHA,
        graph: withLimits(buildGraph(RIGHT_SHA, 2), rightLimits),
      },
      leftNativeEvidence: [],
      rightNativeEvidence: [],
    });
    const expectedLimits = [leftLimits[0]!, rightLimits[0]!];
    const changed = result.graph.edges.find(
      ({ relation }) => relation === "changed_from",
    );

    expect(changed).toBeDefined();
    expect(result.graph.coverage).toMatchObject({
      status: "complete",
      truncated: false,
      omitted_count: 0,
      limits: expectedLimits,
    });
    expect(changed?.evidence.coverage).toMatchObject({
      status: "complete",
      truncated: false,
      omitted_count: 0,
      limits: expectedLimits,
    });
  });

  it("reuses only the owned change graph and validates its enclosing result", () => {
    const result = compare();
    expect(
      ownedApplicationVersionComparisonResultSchema.parse(result).graph,
    ).toBe(result.graph);

    const copied = { ...result, graph: structuredClone(result.graph) };
    expect(
      ownedApplicationVersionComparisonResultSchema.safeParse(copied).error
        ?.issues,
    ).toMatchObject([{ path: ["graph"] }]);
    expect(applicationVersionComparisonResultSchema.parse(copied)).toEqual(
      result,
    );

    for (const status of ["partial", "unknown"] as const) {
      const checked = ownedApplicationVersionComparisonResultSchema.safeParse({
        ...result,
        coverage: { ...result.coverage, status },
      });
      const messages = checked.error?.issues.map(({ path, message }) => ({
        path,
        message,
      }));
      expect(messages).toEqual([
        {
          path: ["coverage", "status"],
          message: "Comparison coverage must match source graph completeness",
        },
        ...(status === "unknown"
          ? [
              {
                path: ["coverage", "status"],
                message:
                  "Comparison coverage is unknown exactly when a source graph's coverage is unknown or unavailable",
              },
            ]
          : []),
      ]);
    }
  });
});

describe("version comparison coverage", () => {
  const withCoverage = (
    graph: JavaScriptApplicationGraph,
    coverage: JavaScriptApplicationGraph["coverage"],
  ): JavaScriptApplicationGraph => {
    const { graph_id: _graphId, ...input } = graph;
    return createJavaScriptApplicationGraph({
      ...input,
      coverage,
      limitations: ["Fixture graph coverage is incomplete."],
    });
  };
  const compareWith = (
    left: JavaScriptApplicationGraph["coverage"],
    right: JavaScriptApplicationGraph["coverage"],
  ) =>
    compareJavaScriptApplicationVersions({
      left: {
        evidenceId: `ev_${"1".repeat(64)}`,
        rootArtifactSha256: LEFT_SHA,
        graph: withCoverage(buildGraph(LEFT_SHA, 1), left),
      },
      right: {
        evidenceId: `ev_${"2".repeat(64)}`,
        rootArtifactSha256: RIGHT_SHA,
        graph: withCoverage(buildGraph(RIGHT_SHA, 2), right),
      },
      leftNativeEvidence: [],
      rightNativeEvidence: [],
    });
  type Coverage = JavaScriptApplicationGraph["coverage"];
  const unknown = (status: "unknown" | "unavailable"): Coverage => ({
    status,
    truncated: false,
    omitted_count: null,
    limits: [],
  });
  const truncated: Coverage = {
    status: "partial",
    truncated: true,
    omitted_count: 3,
    limits: [{ name: "modules", value: 3, unit: "items" }],
  };

  it.each([
    {
      name: "unknown source",
      left: unknown("unknown"),
      right: completeCoverage,
      status: "unknown",
      graphCoverage: {
        status: "unknown",
        truncated: false,
        omitted_count: null,
      },
    },
    {
      name: "unavailable source with truncation",
      left: truncated,
      right: unknown("unavailable"),
      status: "unknown",
      graphCoverage: {
        status: "unknown",
        truncated: false,
        omitted_count: null,
      },
    },
    {
      name: "reported truncation",
      left: truncated,
      right: completeCoverage,
      status: "truncated",
      graphCoverage: { status: "partial", truncated: true, omitted_count: 3 },
    },
  ])(
    "publishes supported coverage for $name",
    ({ left, right, status, graphCoverage }) => {
      const result = compareWith(left, right);
      expect(result.coverage).toEqual({
        status,
        left_graph_status: left.status,
        right_graph_status: right.status,
        left_graph_omitted_count: left.omitted_count,
        right_graph_omitted_count: right.omitted_count,
      });
      expect(result.graph.coverage).toMatchObject(graphCoverage);
      const changed = result.graph.edges.filter(
        ({ relation }) => relation === "changed_from",
      );
      expect(changed.length).toBeGreaterThan(0);
      for (const edge of changed)
        expect(edge.evidence.coverage).toMatchObject(graphCoverage);
    },
  );
});
