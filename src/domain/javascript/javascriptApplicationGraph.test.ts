import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeJavaScriptApplicationGraphSha256,
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  javascriptApplicationGraphSchema,
  mergeJavaScriptApplicationNodes,
  parseJavaScriptApplicationGraph,
  serializeJavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type { ApplicationNode } from "./javascriptApplicationGraphSchemas.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  artifactEvidence,
  buildSyntheticJavaScriptApplicationGraph,
  completeCoverage,
  contentNode,
  firstOf,
  graphForNode,
  inferredArtifactEvidence,
  nodeByLabel,
  runtimeEvidence,
  sourceMapReference,
  unknownEvidence,
} from "./javascriptApplicationGraph.fixture.js";

it("merges observations by entity identity without changing source nodes", () => {
  const evidence = artifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, "main.js");
  const first = contentNode(evidence, { selected: "first" });
  const second = contentNode(evidence, { selected: "second" });
  const reversedIdentity = {
    sha256: APPLICATION_GRAPH_DIGESTS.asar,
    stability: "global-exact" as const,
    strategy: "content-digest" as const,
  };
  const sourceSnapshot = structuredClone([first, second]);
  const merged = mergeJavaScriptApplicationNodes([
    first,
    { ...second, identity: reversedIdentity },
    first,
  ]);
  expect(merged).toMatchObject([
    { node_id: first.node_id, identity: first.identity },
  ]);
  expect(
    merged[0]?.observations
      .map(({ properties }) => properties)
      .sort((left, right) =>
        String(left.selected).localeCompare(String(right.selected)),
      ),
  ).toEqual([{ selected: "first" }, { selected: "second" }]);
  expect([first, second]).toEqual(sourceSnapshot);
});

it("rejects a colliding entity ID when the kind or identity disagrees", () => {
  const node = contentNode(
    artifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, "main.js"),
  );
  const original = structuredClone(node);
  const conflicts = [
    { ...node, kind: "javascript-asset" as const },
    {
      ...node,
      identity: {
        strategy: "content-digest" as const,
        stability: "global-exact" as const,
        sha256: "f".repeat(64),
      },
    },
  ];
  for (const conflict of conflicts)
    expect(() => mergeJavaScriptApplicationNodes([node, conflict])).toThrow(
      "Colliding JAG node identifiers disagree",
    );
  expect(node).toEqual(original);
});

it("preserves deep and wide observation properties in a large native-export graph", () => {
  let nested: unknown = "leaf";
  for (let index = 0; index < 12; index += 1)
    nested = { [`level-${index}`]: nested };
  const largeKey = `export-property-${"k".repeat(120)}`;
  const properties = {
    ...Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`symbol-${index}`, index]),
    ),
    [largeKey]: "v".repeat(4_097),
    nested,
  };
  const longLabel = "large export graph label ".repeat(300);
  const nodes = Array.from({ length: 1_001 }, (_, index) => {
    const path = `native/exports/${index}.symbol`;
    return createJavaScriptApplicationNode({
      kind: "native-export",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
        path,
      },
      observations: [
        {
          label: index === 0 ? longLabel : path,
          properties: index === 0 ? properties : {},
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.nativeAddon,
            path,
            "native-analysis-provider",
          ),
        },
      ],
    });
  });
  const first = firstOf(nodes, "native export");
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [first.node_id],
    nodes,
    edges: [],
    coverage: completeCoverage,
    limitations: [],
  });
  const loaded = parseJavaScriptApplicationGraph(
    JSON.parse(serializeJavaScriptApplicationGraph(graph)),
  );

  expect(loaded.nodes.map(({ node_id }) => node_id).toSorted()).toEqual(
    nodes.map(({ node_id }) => node_id).toSorted(),
  );
  const observation = loaded.nodes.find(
    ({ node_id }) => node_id === first.node_id,
  )?.observations[0];
  expect(observation?.label).toBe(longLabel);
  expect(observation?.properties).toEqual(properties);
});

describe("JavaScript Application Graph: vocabulary", () => {
  it("round-trips one canonical, byte-stable graph", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const serialized = serializeJavaScriptApplicationGraph(graph);
    const decoded: unknown = JSON.parse(serialized);

    expect(parseJavaScriptApplicationGraph(decoded)).toEqual(graph);
    expect(serializeJavaScriptApplicationGraph(decoded)).toBe(serialized);
    expect(computeJavaScriptApplicationGraphSha256(decoded)).toBe(
      createHash("sha256").update(serialized).digest("hex"),
    );

    const { graph_id: _graphId, ...semantic } = graph;
    expect(
      createJavaScriptApplicationGraph({
        ...semantic,
        nodes: semantic.nodes.toReversed(),
        edges: semantic.edges.toReversed(),
      }),
    ).toEqual(graph);
  });
});

describe("JavaScript Application Graph: evidence authority", () => {
  it("keeps static observations, static inferences, runtime facts, and native facts distinct", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const preload = nodeByLabel(graph, "desktop preload");
    const runtime = nodeByLabel(graph, "preload runtime script");
    const nativeExport = nodeByLabel(graph, "openProject");
    const invoke = graph.edges.find(({ relation }) => relation === "invokes");
    const observedAs = graph.edges.find(
      ({ relation }) => relation === "observed_as",
    );

    expect(preload.observations[0]?.evidence).toMatchObject({
      authority: "ast-static-analysis",
      state: "observed",
    });
    expect(invoke?.evidence).toMatchObject({
      authority: "static-relationship-inference",
      state: "inferred",
    });
    expect(runtime.observations[0]?.evidence).toMatchObject({
      authority: "passive-cdp-runtime",
      state: "observed",
    });
    expect(observedAs?.evidence.authority).toBe("passive-cdp-runtime");
    expect(nativeExport.observations[0]?.evidence.authority).toBe(
      "native-analysis-provider",
    );
    expect(preload.node_id).not.toBe(runtime.node_id);
  });

  it("retains unknown observations but requires observed proof for an observation-scoped identity", () => {
    const identity = {
      strategy: "observation-fingerprint",
      stability: "observation-only",
      observation_sha256: "8".repeat(64),
      scope: "synthetic static inventory",
    };
    const unknown = {
      label: null,
      properties: { question: "runtime correspondence" },
      evidence: unknownEvidence(),
    };
    const observed = {
      label: "unclassified entity",
      properties: {},
      evidence: artifactEvidence(
        APPLICATION_GRAPH_DIGESTS.asar,
        "dist/module.js",
      ),
    };
    const node = createJavaScriptApplicationNode({
      kind: "unknown",
      identity,
      observations: [observed, unknown],
    });

    expect(graphForNode(node).nodes[0]?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: { question: "runtime correspondence" },
          evidence: expect.objectContaining({
            state: "unknown",
            authority: "unknown",
            confidence: "unknown",
          }),
        }),
      ]),
    );
    const unsupported = createJavaScriptApplicationNode({
      kind: "unknown",
      identity,
      observations: [unknown],
    });
    expect(() => graphForNode(unsupported)).toThrow(
      /identity is not supported/u,
    );
  });
});

describe("JavaScript Application Graph: identity and evidence", () => {
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

  it("scopes the same artifact path to its version", () => {
    const path = "dist/app.js";
    const asset = (digest: string) =>
      createJavaScriptApplicationNode({
        kind: "javascript-asset",
        identity: {
          strategy: "canonical-path",
          stability: "artifact-version",
          artifact_sha256: digest,
          path,
        },
        observations: [
          {
            label: null,
            properties: {},
            evidence: artifactEvidence(digest, path),
          },
        ],
      });
    const earlier = asset(APPLICATION_GRAPH_DIGESTS.asar);
    const later = asset("7".repeat(64));
    expect(graphForNode(earlier).nodes[0]?.node_id).not.toBe(
      graphForNode(later).nodes[0]?.node_id,
    );
  });
});

it("requires every source-map observation to agree with the original source identity", () => {
  const sourceDigest = "3".repeat(64);
  const reference = sourceMapReference(
    "webpack:///src/editor.ts",
    null,
    "dist/app.js.map",
  );
  const observed = artifactEvidence(
    APPLICATION_GRAPH_DIGESTS.asar,
    "dist/app.js.map",
    "ast-static-analysis",
  );
  const mappedNode = (
    digest: string | null,
    observations: readonly Omit<
      ApplicationNode["observations"][number],
      "observation_id" | "identifier_strategy"
    >[],
  ) =>
    createJavaScriptApplicationNode({
      kind: "source-module",
      identity: {
        strategy: "source-map-original",
        source_root: null,
        stability: "source-map-exact",
        source_map_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        original_source: "webpack:///src/editor.ts",
        source_sha256: digest,
      },
      observations,
    });
  const known = {
    label: "known source",
    source_map_reference: reference,
    properties: { content_sha256: sourceDigest, content_available: true },
    evidence: observed,
  };
  const unknown = {
    ...known,
    label: "unknown source",
    properties: { content_sha256: null, content_available: false },
  };
  const knownGraph = graphForNode(mappedNode(sourceDigest, [known]));
  const unknownGraph = graphForNode(mappedNode(null, [unknown]));
  const rows = [
    {
      graph: knownGraph,
      node: mappedNode(sourceDigest, [
        known,
        { ...known, label: "missing declaration", source_map_reference: null },
        {
          ...known,
          label: "wrong map path",
          source_map_reference: {
            ...reference,
            map_path: "different/map.js.map",
          },
        },
        {
          ...known,
          label: "different digest",
          properties: { content_sha256: "2".repeat(64) },
        },
        { ...known, label: "absent digest", properties: {} },
        {
          ...known,
          label: "discarded content",
          properties: {
            content_sha256: sourceDigest,
            content_available: false,
          },
        },
      ]),
      rejected: [
        "absent digest",
        "different digest",
        "discarded content",
        "missing declaration",
        "wrong map path",
      ],
    },
    {
      graph: unknownGraph,
      node: mappedNode(null, [
        unknown,
        {
          ...unknown,
          label: "unproven digest",
          properties: { content_sha256: sourceDigest },
        },
        {
          ...unknown,
          label: "non-digest content",
          properties: { content_sha256: 7 },
        },
        {
          ...unknown,
          label: "unproven content",
          properties: { content_sha256: null, content_available: true },
        },
      ]),
      rejected: ["non-digest content", "unproven content", "unproven digest"],
    },
  ];
  for (const { graph, node, rejected } of rows) {
    const parsed = javascriptApplicationGraphSchema.safeParse({
      ...graph,
      nodes: [node],
    });
    const badLabels = parsed.error?.issues
      .filter(({ path }) => path.at(-1) === "source_map_reference")
      .map(({ path }) => node.observations[Number(path[3])]?.label)
      .sort();
    expect(badLabels).toEqual(rejected);
  }
});

it("rejects unknown fields and stale nested commitments at their owning fields", () => {
  const graph = buildSyntheticJavaScriptApplicationGraph();
  expect(
    javascriptApplicationGraphSchema.safeParse({ ...graph, surprise: true })
      .error?.issues,
  ).toMatchObject([
    { path: [], code: "unrecognized_keys", keys: ["surprise"] },
  ]);

  const staleNode = structuredClone(graph);
  firstOf(staleNode.nodes, "node").node_id = `jag_node_${"f".repeat(64)}`;
  const staleObservation = structuredClone(graph);
  firstOf(
    firstOf(staleObservation.nodes, "node").observations,
    "observation",
  ).observation_id = `jag_observation_${"f".repeat(64)}`;
  const staleEdge = structuredClone(graph);
  firstOf(staleEdge.edges, "edge").edge_id = `jag_edge_${"f".repeat(64)}`;
  for (const { input, path } of [
    { input: staleNode, path: ["nodes", 0, "node_id"] },
    {
      input: staleObservation,
      path: ["nodes", 0, "observations", 0, "observation_id"],
    },
    { input: staleEdge, path: ["edges", 0, "edge_id"] },
  ])
    expect(
      javascriptApplicationGraphSchema.safeParse(input).error?.issues,
    ).toContainEqual(expect.objectContaining({ path, code: "custom" }));
});

describe("JavaScript Application Graph: duplicate and orphan rejection", () => {
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
        root_node_ids: [preload.node_id],
        nodes: [preload, runtime],
        edges: [invalid],
        coverage: completeCoverage,
        limitations: [],
      }),
    ).toThrow(/changed_from endpoints must have the same node kind/u);
  });
});

it("requires capture provenance for runtime script identities", () => {
  const captureEvidenceId = `ev_${"c".repeat(64)}`;
  const identity = {
    strategy: "runtime-instance",
    stability: "capture-only",
    capture_sha256: APPLICATION_GRAPH_DIGESTS.capture,
    runtime_key: "script-preload",
  };
  const node = (
    candidate: unknown,
    evidence = runtimeEvidence("script-preload"),
  ) =>
    createJavaScriptApplicationNode({
      kind: "runtime-script-instance",
      identity: candidate,
      observations: [{ label: "preload", properties: {}, evidence }],
    });
  expect(() => node(identity)).toThrow(/capture_evidence_id/u);
  const matching = { ...identity, capture_evidence_id: captureEvidenceId };
  const runtime = node(matching);
  expect(graphForNode(runtime).nodes).toEqual([runtime]);

  const otherEvidenceId = `ev_${"d".repeat(64)}`;
  const foreign = { ...identity, capture_evidence_id: otherEvidenceId };
  expect(() => graphForNode(node(foreign))).toThrow(
    /identity is not supported/u,
  );
  expect(() =>
    graphForNode(
      node(
        matching,
        artifactEvidence(
          APPLICATION_GRAPH_DIGESTS.asar,
          "dist/preload.js",
          "ast-static-analysis",
        ),
      ),
    ),
  ).toThrow(/identity is not supported/u);
  const otherEvidence = runtimeEvidence("script-preload");
  otherEvidence.evidence_ids = [otherEvidenceId];
  const otherCapture = node(foreign, otherEvidence);
  expect(graphForNode(otherCapture).nodes[0]?.node_id).not.toBe(
    runtime.node_id,
  );

  const otherDigest = "6".repeat(64);
  const otherLocation = runtimeEvidence("script-preload");
  if (
    !otherLocation.location.available ||
    otherLocation.location.value.kind !== "runtime"
  )
    throw new Error("Missing fixture runtime location");
  otherLocation.location.value.capture_sha256 = otherDigest;
  const relocatedCapture = node(
    { ...matching, capture_sha256: otherDigest },
    otherLocation,
  );
  expect(graphForNode(relocatedCapture).nodes[0]?.node_id).not.toBe(
    runtime.node_id,
  );
});

describe("JavaScript Application Graph: identity strategy requirements", () => {
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

    const mismatchedDigest = contentNode(
      artifactEvidence("7".repeat(64), "dist/module.js"),
    );
    expect(() => graphForNode(mismatchedDigest)).toThrow(
      /identity is not supported/u,
    );
  });

  it.each([
    { start: { line: 2, column: 0 }, end: { line: 1, column: 9 } },
    { start: { line: 1, column: 9 }, end: { line: 1, column: 0 } },
  ])("rejects reversed source locations on graph facts: %j", (range) => {
    const evidence = artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
      "ast-static-analysis",
    );
    evidence.location = {
      available: true,
      value: { kind: "source-range", source: "dist/module.js", ...range },
    };
    expect(() => graphForNode(contentNode(evidence))).toThrow(
      /Source range end must not precede its start/u,
    );
  });

  it("requires static and native locations to agree with their observation authority", () => {
    const path = "dist/module.js";
    const base = contentNode(
      artifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, path),
    );
    const graph = graphForNode(base);
    const badAuthority = [
      "ast-static-analysis",
      "managed-static-analysis",
      "native-analysis-provider",
    ] as const;
    const mixed = firstOf(
      mergeJavaScriptApplicationNodes([
        base,
        ...badAuthority.map((authority) => {
          const evidence = artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            path,
            authority,
          );
          evidence.location = runtimeEvidence("script-module").location;
          return contentNode(evidence);
        }),
      ]),
      "mixed authority node",
    );
    const rejected = javascriptApplicationGraphSchema
      .safeParse({
        ...graph,
        nodes: [mixed],
      })
      .error?.issues.filter(
        ({ message, path }) =>
          path.at(-1) === "location" &&
          message ===
            "Static and native authorities cannot claim a runtime location",
      )
      .map(
        ({ path }) => mixed.observations[Number(path[3])]?.evidence.authority,
      )
      .sort();
    expect(rejected).toEqual(badAuthority);
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

describe("JavaScript Application Graph: truncation claims", () => {
  it("rejects false truncation and incomplete-coverage claims", () => {
    const truncated = artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    truncated.coverage = {
      status: "partial",
      truncated: true,
      omitted_count: 0,
      limits: [],
    };
    expect(() => contentNode(truncated)).toThrow(/omitted_count[\s\S]*limits/u);

    const nonComplete = artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    nonComplete.coverage = {
      status: "partial",
      truncated: false,
      omitted_count: null,
      limits: [],
    };
    expect(() => contentNode(nonComplete)).toThrow(
      /Non-complete coverage requires an explicit limitation/u,
    );

    const validNode = contentNode(
      artifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, "dist/module.js"),
    );
    expect(() =>
      createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        root_node_ids: [validNode.node_id],
        nodes: [validNode],
        edges: [],
        coverage: {
          status: "partial",
          truncated: false,
          omitted_count: null,
          limits: [],
        },
        limitations: [],
      }),
    ).toThrow(/Non-complete graph coverage requires an explicit limitation/u);
  });
});
