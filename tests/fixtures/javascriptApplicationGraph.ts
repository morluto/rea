import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  type ApplicationGraphEvidence,
  type JavaScriptApplicationGraph,
} from "../../src/domain/javascriptApplicationGraph.js";

export const APPLICATION_GRAPH_DIGESTS = {
  package: "1".repeat(64),
  asar: "2".repeat(64),
  nativeAddon: "3".repeat(64),
  capture: "4".repeat(64),
} as const;

const completeCoverage = {
  status: "complete" as const,
  truncated: false,
  omitted_count: 0,
  limits: [],
};

const extractor = (operation: string) => ({
  name: "rea-test-fixture",
  version: "1.0.0",
  operation,
  executable_sha256: null,
});

export const artifactEvidence = (
  sha256: string,
  path: string,
  authority:
    | "artifact-bytes"
    | "ast-static-analysis"
    | "native-analysis-provider" = "artifact-bytes",
): ApplicationGraphEvidence => ({
  authority,
  state: "observed",
  confidence: "exact",
  artifact: {
    available: true,
    artifact_id: `art_${sha256}`,
    sha256,
  },
  location: { available: true, value: { kind: "artifact-path", path } },
  extractor: extractor(`observe-${authority}`),
  coverage: completeCoverage,
  limitations: [],
  evidence_ids: [],
});

export const inferredArtifactEvidence = (
  sha256: string,
  path: string,
): ApplicationGraphEvidence => ({
  authority: "static-relationship-inference",
  state: "inferred",
  confidence: "high",
  artifact: {
    available: true,
    artifact_id: `art_${sha256}`,
    sha256,
  },
  location: { available: true, value: { kind: "artifact-path", path } },
  extractor: extractor("infer-static-relationship"),
  coverage: completeCoverage,
  limitations: ["Relationship is inferred from static syntax."],
  evidence_ids: [],
});

export const runtimeEvidence = (
  runtimeKey: string,
): ApplicationGraphEvidence => ({
  authority: "passive-cdp-runtime",
  state: "observed",
  confidence: "exact",
  artifact: {
    available: false,
    reason: "not-observed",
    detail: "Passive CDP metadata did not expose backing artifact bytes.",
  },
  location: {
    available: true,
    value: {
      kind: "runtime",
      capture_sha256: APPLICATION_GRAPH_DIGESTS.capture,
      target_key: "target-main",
      frame_key: "frame-main",
      script_key: runtimeKey,
    },
  },
  extractor: extractor("observe-passive-cdp"),
  coverage: completeCoverage,
  limitations: ["Only passive CDP metadata was observed."],
  evidence_ids: [],
});

/** Build a synthetic cross-layer Electron graph without proprietary artifacts. */
export const buildSyntheticJavaScriptApplicationGraph =
  (): JavaScriptApplicationGraph => {
    const packageNode = createJavaScriptApplicationNode({
      kind: "package",
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256: APPLICATION_GRAPH_DIGESTS.package,
      },
      observations: [
        {
          label: "Synthetic desktop package",
          properties: { format: "directory" },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.package,
            "package.json",
          ),
        },
      ],
    });
    const asarNode = createJavaScriptApplicationNode({
      kind: "artifact",
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256: APPLICATION_GRAPH_DIGESTS.asar,
      },
      observations: [
        {
          label: "resources/app.asar",
          properties: { format: "asar" },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "resources/app.asar",
          ),
        },
      ],
    });
    const preloadNode = createJavaScriptApplicationNode({
      kind: "electron-preload",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        path: "dist/preload.js",
      },
      observations: [
        {
          label: "desktop preload",
          properties: { sandboxed: true },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/preload.js",
            "ast-static-analysis",
          ),
        },
      ],
    });
    const bridgeNode = createJavaScriptApplicationNode({
      kind: "context-bridge-api",
      identity: {
        strategy: "artifact-local-key",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        namespace: "contextBridge",
        key: "desktopApi",
      },
      observations: [
        {
          label: "desktopApi",
          properties: { methods: ["openProject"] },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/preload.js",
            "ast-static-analysis",
          ),
        },
      ],
    });
    const channelNode = createJavaScriptApplicationNode({
      kind: "ipc-channel",
      identity: {
        strategy: "artifact-local-key",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        namespace: "electron-ipc",
        key: "project:open",
      },
      observations: [
        {
          label: "project:open",
          properties: { mode: "invoke" },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/preload.js",
            "ast-static-analysis",
          ),
        },
      ],
    });
    const handlerNode = createJavaScriptApplicationNode({
      kind: "ipc-handler",
      identity: {
        strategy: "artifact-local-key",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        namespace: "ipcMain.handle",
        key: "project:open",
      },
      observations: [
        {
          label: "project open handler",
          properties: { process: "main" },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "dist/main.js",
            "ast-static-analysis",
          ),
        },
      ],
    });
    const addonNode = createJavaScriptApplicationNode({
      kind: "native-addon",
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
      },
      observations: [
        {
          label: "synthetic.node",
          properties: { abi: "napi" },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.nativeAddon,
            "native/synthetic.node",
            "native-analysis-provider",
          ),
        },
      ],
    });
    const exportNode = createJavaScriptApplicationNode({
      kind: "native-export",
      identity: {
        strategy: "artifact-local-key",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
        namespace: "napi-export",
        key: "openProject",
      },
      observations: [
        {
          label: "openProject",
          properties: { calling_convention: "napi" },
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.nativeAddon,
            "native/synthetic.node",
            "native-analysis-provider",
          ),
        },
      ],
    });
    const runtimeNode = createJavaScriptApplicationNode({
      kind: "runtime-script-instance",
      identity: {
        strategy: "runtime-instance",
        stability: "capture-only",
        capture_sha256: APPLICATION_GRAPH_DIGESTS.capture,
        runtime_key: "script-preload",
      },
      observations: [
        {
          label: "preload runtime script",
          properties: { url: "file:///synthetic/dist/preload.js" },
          evidence: runtimeEvidence("script-preload"),
        },
      ],
    });

    const observedEdge = (
      sourceNodeId: string,
      targetNodeId: string,
      relation: "contains" | "exposes" | "handles",
      evidence: ApplicationGraphEvidence,
    ) =>
      createJavaScriptApplicationEdge({
        source_node_id: sourceNodeId,
        target_node_id: targetNodeId,
        relation,
        properties: {},
        evidence,
      });
    const inferredEdge = (
      sourceNodeId: string,
      targetNodeId: string,
      relation: "invokes" | "calls" | "loads",
      path: string,
    ) =>
      createJavaScriptApplicationEdge({
        source_node_id: sourceNodeId,
        target_node_id: targetNodeId,
        relation,
        properties: {},
        evidence: inferredArtifactEvidence(
          APPLICATION_GRAPH_DIGESTS.asar,
          path,
        ),
      });

    const nodes = [
      packageNode,
      asarNode,
      preloadNode,
      bridgeNode,
      channelNode,
      handlerNode,
      addonNode,
      exportNode,
      runtimeNode,
    ];
    const edges = [
      observedEdge(
        packageNode.node_id,
        asarNode.node_id,
        "contains",
        artifactEvidence(
          APPLICATION_GRAPH_DIGESTS.package,
          "resources/app.asar",
        ),
      ),
      observedEdge(
        asarNode.node_id,
        preloadNode.node_id,
        "contains",
        artifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, "dist/preload.js"),
      ),
      observedEdge(
        preloadNode.node_id,
        bridgeNode.node_id,
        "exposes",
        artifactEvidence(
          APPLICATION_GRAPH_DIGESTS.asar,
          "dist/preload.js",
          "ast-static-analysis",
        ),
      ),
      inferredEdge(
        bridgeNode.node_id,
        channelNode.node_id,
        "invokes",
        "dist/preload.js",
      ),
      observedEdge(
        channelNode.node_id,
        handlerNode.node_id,
        "handles",
        artifactEvidence(
          APPLICATION_GRAPH_DIGESTS.asar,
          "dist/main.js",
          "ast-static-analysis",
        ),
      ),
      inferredEdge(
        handlerNode.node_id,
        addonNode.node_id,
        "loads",
        "dist/main.js",
      ),
      inferredEdge(
        handlerNode.node_id,
        exportNode.node_id,
        "calls",
        "dist/main.js",
      ),
      observedEdge(
        addonNode.node_id,
        exportNode.node_id,
        "contains",
        artifactEvidence(
          APPLICATION_GRAPH_DIGESTS.nativeAddon,
          "native/synthetic.node",
          "native-analysis-provider",
        ),
      ),
      createJavaScriptApplicationEdge({
        source_node_id: preloadNode.node_id,
        target_node_id: runtimeNode.node_id,
        relation: "observed_as",
        properties: {},
        evidence: runtimeEvidence("script-preload"),
      }),
    ];

    return createJavaScriptApplicationGraph({
      schema: "JavaScriptApplicationGraph",
      schema_version: 1,
      root_node_ids: [packageNode.node_id],
      nodes,
      edges,
      coverage: completeCoverage,
      limitations: [
        "Synthetic fixture demonstrates identity and authority boundaries only.",
      ],
    });
  };
