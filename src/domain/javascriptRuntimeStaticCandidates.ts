import { isAbsolute, posix, relative } from "node:path";

import {
  compareCodePoints,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type { ParsedStaticLayer } from "./javascriptRuntimeReconciliationParsing.js";
import type { RuntimeReconciliationEntity } from "./javascriptRuntimeReconciliationRuntime.js";

export interface StaticRuntimeCandidate {
  readonly layer: ParsedStaticLayer;
  readonly node: ApplicationNode;
  readonly category: "renderer" | "javascript" | "worker" | "service-worker";
  readonly paths: readonly string[];
  readonly digests: readonly {
    readonly sha256: string;
    readonly basis: "content-sha256" | "module-source-sha256";
  }[];
}

export interface MappedRuntimePath {
  readonly path: string;
  readonly basis:
    | "artifact-path"
    | "operator-file-mapping"
    | "operator-url-mapping";
}

/** Precomputed mapping scope and graph paths for static load-state decisions. */
export interface StaticRuntimeScope {
  readonly artifactPrefixes: readonly string[];
  readonly pathsByNodeId: ReadonlyMap<string, readonly string[]>;
}

/** Index statically reconstructed entities that can receive runtime matches. */
export const collectStaticRuntimeCandidates = (
  layers: readonly ParsedStaticLayer[],
): StaticRuntimeCandidate[] =>
  layers
    .flatMap((layer) => candidatesForLayer(layer))
    .sort(
      (left, right) =>
        compareCodePoints(left.layer.layerId, right.layer.layerId) ||
        compareCodePoints(left.node.node_id, right.node.node_id),
    );

/** Translate one already-authorized runtime location into artifact paths. */
export const mappedRuntimePaths = (
  layer: ParsedStaticLayer,
  entity: RuntimeReconciliationEntity,
): MappedRuntimePath[] => {
  const paths: MappedRuntimePath[] = [];
  if (entity.location.kind === "file" && layer.result.format === "directory") {
    const path = pathBelowRoot(layer.result.input_path, entity.location.value);
    if (path !== null) paths.push({ path, basis: "artifact-path" });
  }
  for (const mapping of layer.runtimeMappings) {
    const suffix =
      mapping.kind === "file-root" && entity.location.kind === "file"
        ? pathBelowRoot(mapping.root, entity.location.value)
        : mapping.kind === "url-prefix" && entity.location.kind === "url"
          ? pathBelowUrlPrefix(mapping.prefix, entity.location.value)
          : null;
    if (suffix === null) continue;
    const path = safeArtifactPath(mapping.artifact_prefix, suffix);
    if (path === null) continue;
    paths.push({
      path,
      basis:
        mapping.kind === "file-root"
          ? "operator-file-mapping"
          : "operator-url-mapping",
    });
  }
  return uniqueMappedPaths(paths);
};

/** Precompute the artifact prefixes exercised by a bounded runtime set. */
export const createStaticRuntimeScope = (
  layer: ParsedStaticLayer,
  entities: readonly RuntimeReconciliationEntity[],
): StaticRuntimeScope => ({
  artifactPrefixes: activeArtifactPrefixes(layer, entities),
  pathsByNodeId: indexStaticPaths(layer.graph),
});

/** Whether one static node falls under a mapping exercised by this runtime set. */
export const staticNodeWithinRuntimeScope = (
  node: ApplicationNode,
  scope: StaticRuntimeScope,
): boolean =>
  (scope.pathsByNodeId.get(node.node_id) ?? []).some((path) =>
    scope.artifactPrefixes.some((prefix) => pathWithinPrefix(path, prefix)),
  );

const candidatesForLayer = (
  layer: ParsedStaticLayer,
): StaticRuntimeCandidate[] => {
  const graph = layer.graph;
  const pathsByNodeId = indexStaticPaths(graph);
  return graph.nodes.flatMap((node) => {
    const category = candidateCategory(node);
    if (category === null) return [];
    return [
      {
        layer,
        node,
        category,
        paths: pathsByNodeId.get(node.node_id) ?? [],
        digests: candidateDigests(node),
      },
    ];
  });
};

const candidateCategory = (
  node: ApplicationNode,
): StaticRuntimeCandidate["category"] | null => {
  if (node.kind === "electron-renderer") return "renderer";
  if (node.kind === "javascript-asset" || node.kind === "javascript-module")
    return "javascript";
  if (node.kind === "worker") return "worker";
  if (node.kind === "service-worker") return "service-worker";
  return null;
};

const indexStaticPaths = (
  graph: JavaScriptApplicationGraph,
): ReadonlyMap<string, readonly string[]> => {
  const nodes = new Map(
    graph.nodes.map((candidate) => [candidate.node_id, candidate]),
  );
  const relatedBySource = new Map<string, ApplicationNode[]>();
  for (const edge of graph.edges) {
    if (edge.relation !== "maps_to") continue;
    const target = nodes.get(edge.target_node_id);
    if (target === undefined) continue;
    const related = relatedBySource.get(edge.source_node_id);
    if (related === undefined)
      relatedBySource.set(edge.source_node_id, [target]);
    else related.push(target);
  }
  return new Map(
    graph.nodes.map((node) => [
      node.node_id,
      uniqueSorted([
        ...nodePaths(node),
        ...(relatedBySource.get(node.node_id) ?? []).flatMap(nodePaths),
      ]),
    ]),
  );
};

const nodePaths = (node: ApplicationNode): string[] => {
  const paths: string[] = [];
  if (node.identity.strategy === "canonical-path")
    paths.push(node.identity.path);
  for (const observation of node.observations) {
    for (const property of ["path", "resolved_path", "declared_path"])
      if (typeof observation.properties[property] === "string")
        paths.push(observation.properties[property]);
    if (
      observation.evidence.location.available &&
      observation.evidence.location.value.kind === "artifact-path"
    )
      paths.push(observation.evidence.location.value.path);
  }
  return paths
    .map(normalizeArtifactPath)
    .filter(
      (path): path is string => path !== null && path !== "artifact-root",
    );
};

const candidateDigests = (
  node: ApplicationNode,
): StaticRuntimeCandidate["digests"] => {
  const values: StaticRuntimeCandidate["digests"][number][] = [];
  if (
    node.kind === "javascript-asset" &&
    node.identity.strategy === "content-digest"
  )
    values.push({
      sha256: node.identity.sha256,
      basis: "content-sha256",
    });
  if (node.kind === "javascript-module")
    for (const observation of node.observations) {
      const digest = observation.properties.source_sha256;
      if (typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest))
        values.push({ sha256: digest, basis: "module-source-sha256" });
    }
  return [
    ...new Map(
      values.map((value) => [`${value.basis}:${value.sha256}`, value]),
    ).values(),
  ];
};

const pathBelowRoot = (root: string, value: string): string | null => {
  const remainder = relative(root, value);
  if (
    remainder === "" ||
    remainder.startsWith("..") ||
    isAbsolute(remainder) ||
    remainder.includes("\\")
  )
    return null;
  return normalizeArtifactPath(remainder);
};

const pathBelowUrlPrefix = (prefix: string, value: string): string | null => {
  let base: URL;
  let candidate: URL;
  try {
    base = new URL(prefix);
    candidate = new URL(value);
  } catch {
    return null;
  }
  if (
    base.origin !== candidate.origin ||
    !candidate.pathname.startsWith(base.pathname)
  )
    return null;
  try {
    return normalizeArtifactPath(
      decodeURIComponent(candidate.pathname.slice(base.pathname.length)),
    );
  } catch {
    return null;
  }
};

const activeArtifactPrefixes = (
  layer: ParsedStaticLayer,
  entities: readonly RuntimeReconciliationEntity[],
): string[] => {
  const prefixes = new Set<string>();
  if (
    layer.result.format === "directory" &&
    entities.some(
      ({ location }) =>
        location.kind === "file" &&
        pathBelowRoot(layer.result.input_path, location.value) !== null,
    )
  )
    prefixes.add("");
  for (const mapping of layer.runtimeMappings)
    if (
      entities.some(({ location }) =>
        mapping.kind === "file-root" && location.kind === "file"
          ? pathBelowRoot(mapping.root, location.value) !== null
          : mapping.kind === "url-prefix" && location.kind === "url"
            ? pathBelowUrlPrefix(mapping.prefix, location.value) !== null
            : false,
      )
    )
      prefixes.add(mapping.artifact_prefix);
  return [...prefixes].sort(compareCodePoints);
};

const pathWithinPrefix = (path: string, prefix: string): boolean =>
  prefix === "" || path === prefix || path.startsWith(`${prefix}/`);

const safeArtifactPath = (prefix: string, suffix: string): string | null =>
  normalizeArtifactPath(prefix === "" ? suffix : posix.join(prefix, suffix));

const normalizeArtifactPath = (value: string): string | null => {
  const normalized = posix
    .normalize(value.replaceAll("\\", "/"))
    .replace(/^\.\//u, "");
  return normalized !== "" &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("/") &&
    !normalized.startsWith("../")
    ? normalized
    : null;
};

const uniqueMappedPaths = (
  values: readonly MappedRuntimePath[],
): MappedRuntimePath[] =>
  [
    ...new Map(
      values.map((value) => [`${value.basis}:${value.path}`, value]),
    ).values(),
  ].sort(
    (left, right) =>
      compareCodePoints(left.path, right.path) ||
      compareCodePoints(left.basis, right.basis),
  );

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodePoints);
