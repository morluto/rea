import type { Evidence } from "./evidence.js";
import {
  compareCodePoints,
  type ApplicationEdge,
  type ApplicationNode,
} from "./javascriptApplicationGraph.js";
import type { ApplicationFeatureTraceResult } from "./javascriptFeatureTraceSchemas.js";

type NativeHandoff = ApplicationFeatureTraceResult["native_handoffs"][number];

/** Build provider-neutral addon targets and link exact-subject native Evidence. */
export const buildJavaScriptNativeHandoffs = (
  nodes: readonly ApplicationNode[],
  edges: readonly ApplicationEdge[],
  nativeEvidence: readonly Evidence[],
): NativeHandoff[] => {
  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));
  return nodes
    .filter(({ kind }) => kind === "native-addon")
    .flatMap((node) => {
      const digest = artifactDigest(node);
      if (digest === null) return [];
      const linked = nativeEvidence.filter(
        ({ subject }) => subject?.digest.sha256 === digest,
      );
      const exportNodes = nativeExportNodes(node, edges, nodeById);
      return [
        {
          native_node_id: node.node_id,
          artifact_sha256: digest,
          artifact_path: artifactPath(node),
          export_node_ids: exportNodes.map(({ node_id: id }) => id),
          requested_exports: requestedExports(exportNodes),
          status:
            linked.length === 0
              ? ("requires-provider-analysis" as const)
              : ("evidence-linked" as const),
          providers: uniqueProviders(linked),
          evidence_ids: linked
            .map(({ evidence_id: id }) => id)
            .sort(compareCodePoints),
          recommended_tools: [
            "open_binary" as const,
            "binary_overview" as const,
            "search_procedures" as const,
            "analyze_function" as const,
            "xrefs" as const,
          ],
        },
      ];
    })
    .sort((left, right) =>
      compareCodePoints(left.native_node_id, right.native_node_id),
    );
};

const artifactDigest = (node: ApplicationNode): string | null => {
  if (node.identity.strategy === "content-digest") return node.identity.sha256;
  const observation = node.observations.find(
    ({ evidence }) => evidence.artifact.available,
  );
  return observation?.evidence.artifact.available === true
    ? observation.evidence.artifact.sha256
    : null;
};

const artifactPath = (node: ApplicationNode): string | null => {
  for (const { evidence } of node.observations)
    if (
      evidence.location.available &&
      evidence.location.value.kind === "artifact-path"
    )
      return evidence.location.value.path;
  return null;
};

const nativeExportNodes = (
  addon: ApplicationNode,
  edges: readonly ApplicationEdge[],
  nodeById: ReadonlyMap<string, ApplicationNode>,
): ApplicationNode[] => {
  const ids = edges.flatMap((edge) => {
    if (
      edge.source_node_id === addon.node_id &&
      ["contains", "exposes"].includes(edge.relation)
    )
      return [edge.target_node_id];
    if (
      edge.target_node_id === addon.node_id &&
      ["imports", "loads"].includes(edge.relation)
    )
      return [edge.source_node_id];
    return [];
  });
  return [...new Set(ids)]
    .map((id) => nodeById.get(id))
    .filter((node): node is ApplicationNode => node?.kind === "native-export")
    .sort((left, right) => compareCodePoints(left.node_id, right.node_id));
};

const requestedExports = (nodes: readonly ApplicationNode[]): string[] => {
  const values = nodes.flatMap((node) =>
    node.observations.flatMap((observation) => [
      ...(observation.label === null ? [] : [observation.label]),
      ...stringArray(observation.properties.requested_members),
      ...stringArray(observation.properties.members),
    ]),
  );
  return [...new Set(values)].sort(compareCodePoints).slice(0, 1_000);
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const uniqueProviders = (
  evidence: readonly Evidence[],
): NativeHandoff["providers"] =>
  [
    ...new Map(
      evidence.map(({ provider }) => [
        `${provider.id}\0${provider.name}\0${provider.version ?? ""}`,
        provider,
      ]),
    ).values(),
  ].sort((left, right) =>
    compareCodePoints(
      `${left.id}\0${left.name}\0${left.version ?? ""}`,
      `${right.id}\0${right.name}\0${right.version ?? ""}`,
    ),
  );
