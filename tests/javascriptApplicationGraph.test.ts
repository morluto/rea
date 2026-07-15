import { describe, expect, it } from "vitest";

import {
  computeJavaScriptApplicationGraphSha256,
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  javascriptApplicationGraphSchema,
  parseJavaScriptApplicationGraph,
  serializeJavaScriptApplicationGraph,
  type ApplicationGraphEvidence,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "../src/domain/javascriptApplicationGraph.js";
import {
  JAVASCRIPT_APPLICATION_NODE_KINDS,
  JAVASCRIPT_APPLICATION_RELATIONS,
} from "../src/domain/javascriptApplicationGraphSchemas.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  artifactEvidence,
  buildSyntheticJavaScriptApplicationGraph,
  inferredArtifactEvidence,
  runtimeEvidence,
} from "./fixtures/javascriptApplicationGraph.js";

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
  it("defines the complete provider-neutral v1 node and relation vocabulary", () => {
    expect(JAVASCRIPT_APPLICATION_NODE_KINDS).toEqual([
      "package",
      "installer",
      "artifact",
      "asar-entry",
      "electron-main",
      "electron-preload",
      "electron-renderer",
      "electron-utility",
      "javascript-asset",
      "javascript-chunk",
      "javascript-module",
      "source-map",
      "source-module",
      "browser-window",
      "frame",
      "target",
      "context-bridge-api",
      "ipc-channel",
      "ipc-handler",
      "worker",
      "service-worker",
      "endpoint",
      "storage",
      "native-addon",
      "native-export",
      "runtime-script-instance",
      "unknown",
    ]);
    expect(JAVASCRIPT_APPLICATION_RELATIONS).toEqual([
      "contains",
      "loads",
      "imports",
      "maps_to",
      "exposes",
      "sends",
      "invokes",
      "handles",
      "calls",
      "persists_to",
      "observed_as",
      "changed_from",
    ]);
  });

  it("round-trips one canonical, versioned, byte-stable graph", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const serialized = serializeJavaScriptApplicationGraph(graph);
    const decoded: unknown = JSON.parse(serialized);

    expect(parseJavaScriptApplicationGraph(decoded)).toEqual(graph);
    expect(javascriptApplicationGraphSchema.parse(decoded)).toEqual(graph);
    expect(serializeJavaScriptApplicationGraph(decoded)).toBe(serialized);
    expect(computeJavaScriptApplicationGraphSha256(decoded)).toMatch(
      /^[a-f0-9]{64}$/u,
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

  it("represents the synthetic ASAR to preload to IPC to native chain", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const labels = [
      "resources/app.asar",
      "desktop preload",
      "desktopApi",
      "project:open",
      "project open handler",
      "synthetic.node",
      "openProject",
    ];
    const chain = labels.map((label) => nodeByLabel(graph, label));
    const expectedRelations = [
      "contains",
      "exposes",
      "invokes",
      "handles",
      "loads",
      "contains",
    ];

    for (let index = 0; index < expectedRelations.length; index += 1)
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          source_node_id: chain[index]?.node_id,
          target_node_id: chain[index + 1]?.node_id,
          relation: expectedRelations[index],
        }),
      );
    expect(chain.at(-2)?.kind).toBe("native-addon");
    expect(chain.at(-1)?.kind).toBe("native-export");
  });

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
    expect(observedAs?.identifier_strategy).toEqual({
      strategy: "semantic-content-sha256",
      stability: "relationship-exact",
    });
    expect(runtime.observations[0]?.identifier_strategy).toEqual({
      strategy: "semantic-content-sha256",
      stability: "observation-exact",
    });
    expect(nativeExport.observations[0]?.evidence.authority).toBe(
      "native-analysis-provider",
    );
    expect(preload.node_id).not.toBe(runtime.node_id);
  });

  it("retains explicit unknown observations without using them as identity proof", () => {
    const node = createJavaScriptApplicationNode({
      kind: "javascript-module",
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256: APPLICATION_GRAPH_DIGESTS.asar,
      },
      observations: [
        {
          label: "observed module",
          properties: {},
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/module.js",
          ),
        },
        {
          label: null,
          properties: { question: "runtime correspondence" },
          evidence: unknownEvidence(),
        },
      ],
    });

    const graph = graphForNode(node);
    expect(
      graph.nodes[0]?.observations.find(
        ({ evidence }) => evidence.state === "unknown",
      )?.evidence,
    ).toMatchObject({ authority: "unknown", confidence: "unknown" });
  });

  it("separates stable entity identity from changing observations", () => {
    const identity = {
      strategy: "canonical-path" as const,
      stability: "artifact-version" as const,
      artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
      path: "dist/chunk.js",
    };
    const first = createJavaScriptApplicationNode({
      kind: "javascript-chunk",
      identity,
      observations: [
        {
          label: "first label",
          properties: { modules: 10 },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/chunk.js",
            "ast-static-analysis",
          ),
        },
      ],
    });
    const second = createJavaScriptApplicationNode({
      kind: "javascript-chunk",
      identity,
      observations: [
        {
          label: "renamed chunk",
          properties: { modules: 11 },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/chunk.js",
            "ast-static-analysis",
          ),
        },
      ],
    });

    expect(first.node_id).toBe(second.node_id);
    expect(first.observations[0]?.observation_id).not.toBe(
      second.observations[0]?.observation_id,
    );
  });

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

  it("rejects false truncation claims and unbounded properties", () => {
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
    expect(() => contentNode(truncated)).toThrow(
      /must be partial, name a limit, and not claim zero omissions/u,
    );

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
        schema_version: 1,
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

    const properties = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key-${String(index)}`, index]),
    );
    expect(() =>
      contentNode(
        artifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, "dist/module.js"),
        properties,
      ),
    ).toThrow(/exceed 64 keys/u);
  });
});
