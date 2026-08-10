import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  type ApplicationGraphEvidence,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";

export const APPLICATION_GRAPH_DIGESTS = {
  package: "1".repeat(64),
  asar: "2".repeat(64),
  nativeAddon: "3".repeat(64),
  capture: "4".repeat(64),
} as const;

const completeCoverage = {
  status: "complete",
  truncated: false,
  omitted_count: 0,
  limits: [],
} satisfies ApplicationGraphEvidence["coverage"];

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

type FixtureNode = ReturnType<typeof createJavaScriptApplicationNode>;
type NodeProperties = FixtureNode["observations"][number]["properties"];

type FixtureNodeArguments = [
  kind: FixtureNode["kind"],
  identity: FixtureNode["identity"],
  label: string,
  properties: NodeProperties,
  evidence: ApplicationGraphEvidence,
];

const fixtureNode = (
  ...[kind, identity, label, properties, evidence]: FixtureNodeArguments
): FixtureNode =>
  createJavaScriptApplicationNode({
    kind,
    identity,
    observations: [{ label, properties, evidence }],
  });

const buildArtifactNodes = (): FixtureNode[] => [
  fixtureNode(
    "package",
    {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: APPLICATION_GRAPH_DIGESTS.package,
    },
    "Synthetic desktop package",
    { format: "directory" },
    artifactEvidence(APPLICATION_GRAPH_DIGESTS.package, "package.json"),
  ),
  fixtureNode(
    "artifact",
    {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: APPLICATION_GRAPH_DIGESTS.asar,
    },
    "resources/app.asar",
    { format: "asar" },
    artifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, "resources/app.asar"),
  ),
  fixtureNode(
    "electron-preload",
    {
      strategy: "canonical-path",
      stability: "artifact-version",
      artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
      path: "dist/preload.js",
    },
    "desktop preload",
    { sandboxed: true },
    artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/preload.js",
      "ast-static-analysis",
    ),
  ),
];

const buildInteractionNodes = (): FixtureNode[] => [
  fixtureNode(
    "context-bridge-api",
    {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
      namespace: "contextBridge",
      key: "desktopApi",
    },
    "desktopApi",
    { methods: ["openProject"] },
    artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/preload.js",
      "ast-static-analysis",
    ),
  ),
  fixtureNode(
    "ipc-channel",
    {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
      namespace: "electron-ipc",
      key: "project:open",
    },
    "project:open",
    { mode: "invoke" },
    artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/preload.js",
      "ast-static-analysis",
    ),
  ),
  fixtureNode(
    "ipc-handler",
    {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
      namespace: "ipcMain.handle",
      key: "project:open",
    },
    "project open handler",
    { process: "main" },
    artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/main.js",
      "ast-static-analysis",
    ),
  ),
];

const buildNativeRuntimeNodes = (): FixtureNode[] => [
  fixtureNode(
    "native-addon",
    {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
    },
    "synthetic.node",
    { abi: "napi" },
    artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.nativeAddon,
      "native/synthetic.node",
      "native-analysis-provider",
    ),
  ),
  fixtureNode(
    "native-export",
    {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
      namespace: "napi-export",
      key: "openProject",
    },
    "openProject",
    { calling_convention: "napi" },
    artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.nativeAddon,
      "native/synthetic.node",
      "native-analysis-provider",
    ),
  ),
  fixtureNode(
    "runtime-script-instance",
    {
      strategy: "runtime-instance",
      stability: "capture-only",
      capture_sha256: APPLICATION_GRAPH_DIGESTS.capture,
      runtime_key: "script-preload",
    },
    "preload runtime script",
    { url: "file:///synthetic/dist/preload.js" },
    runtimeEvidence("script-preload"),
  ),
];

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
    evidence: inferredArtifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, path),
  });

const buildEdges = (nodes: FixtureNode[]) => {
  const [packageNode, asarNode, preloadNode, bridgeNode, channelNode] = nodes;
  const [handlerNode, addonNode, exportNode, runtimeNode] = nodes.slice(5);
  if (
    packageNode === undefined ||
    asarNode === undefined ||
    preloadNode === undefined ||
    bridgeNode === undefined ||
    channelNode === undefined ||
    handlerNode === undefined ||
    addonNode === undefined ||
    exportNode === undefined ||
    runtimeNode === undefined
  ) {
    throw new Error(
      "Synthetic application graph fixture nodes are incomplete.",
    );
  }
  return [
    observedEdge(
      packageNode.node_id,
      asarNode.node_id,
      "contains",
      artifactEvidence(APPLICATION_GRAPH_DIGESTS.package, "resources/app.asar"),
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
};

/** Build a synthetic cross-layer Electron graph without proprietary artifacts. */
export const buildSyntheticJavaScriptApplicationGraph =
  (): JavaScriptApplicationGraph => {
    const nodes = [
      ...buildArtifactNodes(),
      ...buildInteractionNodes(),
      ...buildNativeRuntimeNodes(),
    ];
    const packageNode = nodes[0];
    if (packageNode === undefined) {
      throw new Error("Synthetic application graph fixture has no root node.");
    }

    return createJavaScriptApplicationGraph({
      schema: "JavaScriptApplicationGraph",
      schema_version: 1,
      root_node_ids: [packageNode.node_id],
      nodes,
      edges: buildEdges(nodes),
      coverage: completeCoverage,
      limitations: [
        "Synthetic fixture demonstrates identity and authority boundaries only.",
      ],
    });
  };
