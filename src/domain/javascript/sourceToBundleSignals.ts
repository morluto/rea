import { posix } from "node:path";

import { compareCodePoints } from "../canonicalOrdering.js";
import type { ApplicationNode } from "./javascriptApplicationGraphSchemas.js";
import type { HistoricalSourceGraph } from "../referenceSourceGraph.js";
import {
  SOURCE_TO_BUNDLE_SIGNAL_WEIGHTS,
  type SourceToBundleCandidate,
  type SourceToBundleSignal,
} from "./sourceToBundleComparisonSchemas.js";
import { isDigest } from "../digests.js";

type SourceFile = Extract<
  HistoricalSourceGraph["entries"][number],
  { readonly kind: "file" }
>;

type CurrentPathKind =
  | "source-map-original"
  | "canonical-path"
  | "observation-path";

interface CurrentPath {
  readonly kind: CurrentPathKind;
  readonly value: string;
  /** Artifact-relative map resolution identifies one path, not its suffixes. */
  readonly allowSuffix: boolean;
}

interface CurrentProjection {
  readonly node: ApplicationNode;
  readonly digests: ReadonlySet<string>;
  readonly paths: readonly CurrentPath[];
}

/** Indexed current-node facts used by deterministic source matching. */
export interface SourceToBundleCandidateIndex {
  readonly nodes: ReadonlyMap<string, CurrentProjection>;
  readonly byDigest: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byPathSuffix: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byBasename: ReadonlyMap<string, ReadonlySet<string>>;
}

const RELEVANT_NODE_KINDS = new Set([
  "javascript-asset",
  "javascript-module",
  "source-module",
]);
const PATH_PROPERTIES = [
  "path",
  "source",
  "original_source",
  "module_path",
  "resolved_path",
  "declared_path",
] as const;

const signalWeight = (kind: SourceToBundleSignal["kind"]): number => {
  const entry = SOURCE_TO_BUNDLE_SIGNAL_WEIGHTS.find(
    ([signal]) => signal === kind,
  );
  if (entry === undefined)
    throw new TypeError(`Missing source-to-bundle signal weight: ${kind}`);
  return entry[1];
};

/** Keep source-bearing application nodes in stable identifier order. */
export const sourceBearingNodes = (
  nodes: readonly ApplicationNode[],
): ApplicationNode[] =>
  nodes
    .filter(({ kind }) => RELEVANT_NODE_KINDS.has(kind))
    .sort((left, right) => compareCodePoints(left.node_id, right.node_id));

/** Keep historical source files in stable path order. */
export const historicalSourceFiles = (
  graph: HistoricalSourceGraph,
): SourceFile[] =>
  graph.entries
    .filter(
      (entry): entry is SourceFile =>
        entry.kind === "file" && entry.classifications.includes("source"),
    )
    .sort((left, right) => compareCodePoints(left.path, right.path));

/** Build deterministic candidate indices without assigning fuzzy matches. */
export const buildSourceToBundleCandidateIndex = (
  nodes: readonly ApplicationNode[],
): SourceToBundleCandidateIndex => {
  const projections = nodes.map(projectCurrentNode);
  const byDigest = new Map<string, Set<string>>();
  const byPathSuffix = new Map<string, Set<string>>();
  const byBasename = new Map<string, Set<string>>();
  for (const projection of projections) {
    for (const digest of projection.digests)
      addIndexValue(byDigest, digest, projection.node.node_id);
    for (const path of projection.paths) {
      for (const suffix of path.allowSuffix
        ? pathSuffixes(path.value)
        : [path.value])
        addIndexValue(byPathSuffix, suffix, projection.node.node_id);
      addIndexValue(
        byBasename,
        posix.basename(path.value),
        projection.node.node_id,
      );
    }
  }
  return {
    nodes: new Map(
      projections.map((projection) => [projection.node.node_id, projection]),
    ),
    byDigest,
    byPathSuffix,
    byBasename,
  };
};

/** Candidate identifiers ordered by strongest available signal, then ID. */
export const candidateIdsForSource = (
  source: SourceFile,
  index: SourceToBundleCandidateIndex,
): string[] => {
  const groups = [
    source.sha256 === null ? undefined : index.byDigest.get(source.sha256),
    index.byPathSuffix.get(source.path),
    index.byBasename.get(posix.basename(source.path)),
  ];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const group of groups) {
    if (group === undefined) continue;
    for (const nodeId of [...group].sort(compareCodePoints)) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      output.push(nodeId);
    }
  }
  return output;
};

/** Score one indexed candidate from explicit, caller-visible signals. */
export const scoreSourceToBundleCandidate = (
  source: SourceFile,
  nodeId: string,
  index: SourceToBundleCandidateIndex,
): SourceToBundleCandidate | null => {
  const projection = index.nodes.get(nodeId);
  if (projection === undefined) return null;
  const signals = candidateSignals(source, projection);
  const score = signals.reduce((total, signal) => total + signal.weight, 0);
  if (score < 20) return null;
  return {
    current_node_id: projection.node.node_id,
    current_node_kind: projection.node.kind,
    score,
    confidence: candidateConfidence(signals),
    signals,
  };
};

const projectCurrentNode = (node: ApplicationNode): CurrentProjection => {
  const digests = new Set<string>();
  const paths: CurrentPath[] = [];
  if (node.identity.strategy === "content-digest")
    digests.add(node.identity.sha256);
  if (node.identity.strategy === "source-map-original") {
    if (node.identity.source_sha256 !== null)
      digests.add(node.identity.source_sha256);
    const mapLocations = node.observations.flatMap(({ evidence }) =>
      evidence.extractor.operation === "parse-local-source-map" &&
      evidence.location.available &&
      evidence.location.value.kind === "artifact-path"
        ? [evidence.location.value.path]
        : [],
    );
    if (mapLocations.length === 0)
      addPath(paths, "source-map-original", node.identity.original_source);
    for (const mapPath of mapLocations)
      addPath(
        paths,
        "source-map-original",
        node.identity.original_source,
        mapPath,
      );
  }
  if (node.identity.strategy === "canonical-path")
    addPath(paths, "canonical-path", node.identity.path);
  for (const observation of node.observations) {
    const sourceDigest = observation.properties.source_sha256;
    if (typeof sourceDigest === "string" && isDigest(sourceDigest))
      digests.add(sourceDigest);
    for (const key of PATH_PROPERTIES) {
      const location = observation.evidence.location;
      const mapPath =
        node.identity.strategy === "source-map-original" &&
        observation.evidence.extractor.operation === "parse-local-source-map" &&
        (key === "source" || key === "original_source") &&
        location.available &&
        location.value.kind === "artifact-path"
          ? location.value.path
          : undefined;
      addJsonPath(paths, observation.properties[key], mapPath);
    }
  }
  return {
    node,
    digests,
    paths: uniquePaths(paths),
  };
};

const candidateSignals = (
  source: SourceFile,
  current: CurrentProjection,
): SourceToBundleSignal[] => {
  const signals: SourceToBundleSignal[] = [];
  if (source.sha256 !== null && current.digests.has(source.sha256))
    signals.push(signal("exact-source-digest", source.sha256, [source.sha256]));
  const sourceMapPaths = matchingPaths(
    source.path,
    current.paths.filter(({ kind }) => kind === "source-map-original"),
  );
  if (sourceMapPaths.length > 0)
    signals.push(
      signal("source-map-original-path", source.path, sourceMapPaths),
    );
  const otherPaths = current.paths.filter(
    ({ kind }) => kind !== "source-map-original",
  );
  const exactPaths = otherPaths
    .filter(({ value }) => value === source.path)
    .map(({ value }) => value);
  if (exactPaths.length > 0)
    signals.push(signal("current-path-exact", source.path, exactPaths));
  const suffixPaths = otherPaths
    .filter(
      ({ value, allowSuffix }) =>
        allowSuffix &&
        value !== source.path &&
        value.endsWith(`/${source.path}`),
    )
    .map(({ value }) => value);
  if (suffixPaths.length > 0)
    signals.push(signal("current-path-suffix", source.path, suffixPaths));
  const basename = posix.basename(source.path);
  const basenamePaths = current.paths
    .filter(({ value }) => posix.basename(value) === basename)
    .map(({ value }) => value);
  if (basenamePaths.length > 0)
    signals.push(signal("basename-match", basename, basenamePaths));
  const extension = posix.extname(source.path).toLowerCase();
  const extensionPaths = current.paths
    .filter(({ value }) => posix.extname(value).toLowerCase() === extension)
    .map(({ value }) => value);
  if (extension !== "" && extensionPaths.length > 0)
    signals.push(signal("language-extension", extension, extensionPaths));
  return signals;
};

const signal = (
  kind: SourceToBundleSignal["kind"],
  sourceValue: string,
  currentValues: readonly string[],
): SourceToBundleSignal => ({
  kind,
  weight: signalWeight(kind),
  source_value: sourceValue,
  current_values: [...new Set(currentValues)].sort(compareCodePoints),
});

const candidateConfidence = (
  signals: readonly SourceToBundleSignal[],
): SourceToBundleCandidate["confidence"] => {
  const kinds = new Set(signals.map(({ kind }) => kind));
  if (kinds.has("exact-source-digest")) return "exact";
  if (kinds.has("source-map-original-path") || kinds.has("current-path-exact"))
    return "high";
  return kinds.has("current-path-suffix") ? "medium" : "low";
};

const matchingPaths = (
  sourcePath: string,
  currentPaths: readonly CurrentPath[],
): string[] =>
  currentPaths
    .filter(
      ({ value, allowSuffix }) =>
        value === sourcePath ||
        (allowSuffix && value.endsWith(`/${sourcePath}`)),
    )
    .map(({ value }) => value);

const addJsonPath = (
  paths: CurrentPath[],
  value: unknown,
  mapPath?: string,
): void => {
  if (typeof value === "string")
    addPath(paths, "observation-path", value, mapPath);
};

const addPath = (
  paths: CurrentPath[],
  kind: CurrentPathKind,
  raw: string,
  mapPath?: string,
): void => {
  const portable = raw.replaceAll("\\", "/");
  const windowsPath = /^[a-z]:\//iu.test(portable);
  const sourceMapReference =
    kind === "source-map-original" || mapPath !== undefined;
  const scheme = windowsPath
    ? undefined
    : (sourceMapReference ? URI_SCHEME : AUTHORITY_URI_SCHEME).exec(
        portable,
      )?.[0];
  // Opaque URI payloads do not establish a filesystem path, even with slash text.
  if (scheme !== undefined && !raw.slice(scheme.length).startsWith("/")) return;
  const reference =
    scheme !== undefined || sourceMapReference
      ? (portable.split(/[?#]/u, 1)[0] ?? "")
      : portable;
  if (
    reference === "" ||
    reference.endsWith("/") ||
    /(?:^|\/)\.{1,2}$/u.test(reference)
  )
    return;
  const relative =
    scheme === undefined && !reference.startsWith("/") && !windowsPath;
  const resolved =
    mapPath !== undefined && relative
      ? posix.join(posix.dirname(mapPath.replaceAll("\\", "/")), reference)
      : reference;
  const value = normalizeCurrentPath(
    scheme === undefined
      ? resolved
      : resolved.slice(scheme.length).replace(/^\/+/u, ""),
  );
  if (value !== null)
    paths.push({
      kind,
      value,
      allowSuffix: mapPath === undefined || !relative,
    });
};

/** Recognize URI schemes even when the URI has no authority component. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
/** Outside source maps, only an explicit authority distinguishes URLs from paths. */
const AUTHORITY_URI_SCHEME = /^[a-z][a-z0-9+.-]*:(?=\/\/)/iu;

const normalizeCurrentPath = (raw: string): string | null => {
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
};

const uniquePaths = (paths: readonly CurrentPath[]): CurrentPath[] =>
  [
    ...new Map(
      paths.map((path) => [
        `${path.kind}\0${path.value}\0${String(path.allowSuffix)}`,
        path,
      ]),
    ).values(),
  ].sort((left, right) =>
    compareCodePoints(
      `${left.kind}\0${left.value}`,
      `${right.kind}\0${right.value}`,
    ),
  );

const pathSuffixes = (path: string): string[] => {
  const parts = path.split("/");
  return parts.map((_, index) => parts.slice(index).join("/"));
};

const addIndexValue = (
  index: Map<string, Set<string>>,
  key: string,
  nodeId: string,
): void => {
  const values = index.get(key) ?? new Set<string>();
  values.add(nodeId);
  index.set(key, values);
};
