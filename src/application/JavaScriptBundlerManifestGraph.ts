import { posix } from "node:path";

import type { ApplicationNode } from "../domain/javascriptApplicationGraph.js";
import type {
  JavaScriptBundlerManifestEntry,
  JavaScriptBundlerManifestObservation,
} from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import {
  artifactLocalIdentity,
  chunkLookupKey,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import {
  artifactObservationEvidence,
  completeReconstructionCoverage,
  partialReconstructionCoverage,
  staticInferenceEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";

interface ManifestEntryRecord {
  readonly manifest: JavaScriptBundlerManifestObservation;
  readonly manifestFile: JavaScriptArtifactFile;
  readonly entry: JavaScriptBundlerManifestEntry;
  readonly node: ApplicationNode;
  readonly resolvedPath: string | null;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

interface ManifestImportInput {
  readonly record: ManifestEntryRecord;
  readonly lookup: ReadonlyMap<string, ManifestEntryRecord>;
  readonly specifier: string;
  readonly importKind: "static" | "dynamic";
}

/** Project Vite/Rollup manifests and esbuild metafiles into bundler chunks. */
export const addJavaScriptBundlerManifestNodes = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const manifest of context.analysis.bundler_manifests) {
    if (manifest.status === "invalid" || manifest.status === "unavailable")
      continue;
    const manifestFile = context.filesByPath.get(manifest.path);
    const manifestNode = context.fileNodes.get(manifest.path);
    if (manifestFile === undefined || manifestNode === undefined) continue;
    const coverage = manifestCoverage(manifest);
    const records = manifest.entries.map((entry) =>
      createManifestEntryRecord(context, {
        manifest,
        manifestFile,
        manifestNode,
        entry,
        coverage,
      }),
    );
    const lookup = manifestEntryLookup(records);
    for (const record of records)
      addManifestEntryRelationships(context, record, lookup);
  }
};

const createManifestEntryRecord = (
  context: JavaScriptArtifactGraphContext,
  input: {
    readonly manifest: JavaScriptBundlerManifestObservation;
    readonly manifestFile: JavaScriptArtifactFile;
    readonly manifestNode: ApplicationNode;
    readonly entry: JavaScriptBundlerManifestEntry;
    readonly coverage: JavaScriptArtifactGraphCoverage;
  },
): ManifestEntryRecord => {
  const { manifest, manifestFile, manifestNode, entry, coverage } = input;
  const resolvedPath =
    entry.file === null
      ? null
      : resolveManifestTargetPath(context, manifest, entry.file);
  const node = context.accumulator.addNode({
    kind: "javascript-chunk",
    identity: artifactLocalIdentity(
      manifestFile.sha256,
      `${manifest.bundler}-manifest-entry`,
      entry.key,
    ),
    observations: [
      {
        label: entry.key,
        properties: {
          bundler: manifest.bundler,
          manifest_kind: manifest.manifest_kind,
          manifest_path: manifest.path,
          entry_key: entry.key,
          source: entry.source,
          file: entry.file,
          resolved_path: resolvedPath,
          entry: entry.entry,
          imports: entry.imports,
          dynamic_imports: entry.dynamic_imports,
          css: entry.css,
          assets: entry.assets,
        },
        evidence: artifactObservationEvidence({
          sha256: manifestFile.sha256,
          path: manifest.path,
          operation: "parse-bundler-manifest-entry",
          coverage,
          limitations:
            manifest.limitation === null ? [] : [manifest.limitation],
        }),
      },
    ],
  });
  context.accumulator.addEdge({
    source_node_id: manifestNode.node_id,
    target_node_id: node.node_id,
    relation: "contains",
    properties: {
      bundler: manifest.bundler,
      manifest_kind: manifest.manifest_kind,
      entry_key: entry.key,
    },
    evidence: staticInferenceEvidence({
      sha256: manifestFile.sha256,
      path: manifest.path,
      operation: "map-bundler-manifest-entry",
      coverage,
    }),
  });
  if (resolvedPath !== null)
    context.chunkNodes.set(
      chunkLookupKey(resolvedPath, manifest.manifest_kind, entry.key),
      node,
    );
  return { manifest, manifestFile, entry, node, resolvedPath, coverage };
};

const addManifestEntryRelationships = (
  context: JavaScriptArtifactGraphContext,
  record: ManifestEntryRecord,
  lookup: ReadonlyMap<string, ManifestEntryRecord>,
): void => {
  addManifestFileMapping(context, record);
  for (const specifier of record.entry.imports)
    addManifestImportEdge(context, {
      record,
      lookup,
      specifier,
      importKind: "static",
    });
  for (const specifier of record.entry.dynamic_imports)
    addManifestImportEdge(context, {
      record,
      lookup,
      specifier,
      importKind: "dynamic",
    });
  for (const specifier of [...record.entry.css, ...record.entry.assets])
    addManifestAssetEdge(context, record, specifier);
};

const addManifestFileMapping = (
  context: JavaScriptArtifactGraphContext,
  record: ManifestEntryRecord,
): void => {
  if (record.resolvedPath === null) return;
  const target = context.fileNodes.get(record.resolvedPath);
  if (target === undefined) return;
  context.accumulator.addEdge({
    source_node_id: record.node.node_id,
    target_node_id: target.node_id,
    relation: "maps_to",
    properties: {
      kind: "bundler-manifest-file",
      bundler: record.manifest.bundler,
      manifest_kind: record.manifest.manifest_kind,
      file: record.entry.file,
      resolved_path: record.resolvedPath,
      resolution_status: "resolved",
    },
    evidence: staticInferenceEvidence({
      sha256: record.manifestFile.sha256,
      path: record.manifest.path,
      operation: "resolve-bundler-manifest-file",
      coverage: record.coverage,
    }),
  });
};

const addManifestImportEdge = (
  context: JavaScriptArtifactGraphContext,
  input: ManifestImportInput,
): void => {
  const { record, lookup, specifier, importKind } = input;
  const targetRecord = resolveManifestEntryReference(
    context,
    record.manifest,
    lookup,
    specifier,
  );
  const target =
    targetRecord?.node ??
    unresolvedManifestChunkNode(context, record, specifier, importKind);
  context.accumulator.addEdge({
    source_node_id: record.node.node_id,
    target_node_id: target.node_id,
    relation: "imports",
    properties: {
      kind: `bundler-manifest-${importKind}-import`,
      bundler: record.manifest.bundler,
      manifest_kind: record.manifest.manifest_kind,
      specifier,
      resolved_path: targetRecord?.resolvedPath ?? null,
      resolution_status: targetRecord === undefined ? "not-found" : "resolved",
    },
    evidence: staticInferenceEvidence({
      sha256: record.manifestFile.sha256,
      path: record.manifest.path,
      operation: "resolve-bundler-manifest-import",
      coverage: record.coverage,
      confidence: targetRecord === undefined ? "low" : "high",
    }),
  });
};

const addManifestAssetEdge = (
  context: JavaScriptArtifactGraphContext,
  record: ManifestEntryRecord,
  specifier: string,
): void => {
  const resolvedPath = resolveManifestTargetPath(
    context,
    record.manifest,
    specifier,
  );
  const target =
    (resolvedPath === null ? undefined : context.fileNodes.get(resolvedPath)) ??
    unresolvedManifestAssetNode(context, record, specifier, resolvedPath);
  context.accumulator.addEdge({
    source_node_id: record.node.node_id,
    target_node_id: target.node_id,
    relation: "imports",
    properties: {
      kind: "bundler-manifest-asset",
      bundler: record.manifest.bundler,
      manifest_kind: record.manifest.manifest_kind,
      specifier,
      resolved_path: resolvedPath,
      resolution_status:
        resolvedPath !== null && context.fileNodes.has(resolvedPath)
          ? "resolved"
          : "not-found",
    },
    evidence: staticInferenceEvidence({
      sha256: record.manifestFile.sha256,
      path: record.manifest.path,
      operation: "resolve-bundler-manifest-asset",
      coverage: record.coverage,
      confidence:
        resolvedPath !== null && context.fileNodes.has(resolvedPath)
          ? "high"
          : "low",
    }),
  });
};

const manifestEntryLookup = (
  records: readonly ManifestEntryRecord[],
): ReadonlyMap<string, ManifestEntryRecord> => {
  const lookup = new Map<string, ManifestEntryRecord>();
  for (const record of records) {
    lookup.set(record.entry.key, record);
    if (record.entry.file !== null) lookup.set(record.entry.file, record);
    if (record.resolvedPath !== null) lookup.set(record.resolvedPath, record);
  }
  return lookup;
};

const resolveManifestEntryReference = (
  context: JavaScriptArtifactGraphContext,
  manifest: JavaScriptBundlerManifestObservation,
  lookup: ReadonlyMap<string, ManifestEntryRecord>,
  specifier: string,
): ManifestEntryRecord | undefined => {
  const direct = lookup.get(specifier);
  if (direct !== undefined) return direct;
  const path = resolveManifestTargetPath(context, manifest, specifier);
  return path === null ? undefined : lookup.get(path);
};

const unresolvedManifestChunkNode = (
  context: JavaScriptArtifactGraphContext,
  record: ManifestEntryRecord,
  specifier: string,
  importKind: "static" | "dynamic",
): ApplicationNode =>
  context.accumulator.addNode({
    kind: "javascript-chunk",
    identity: artifactLocalIdentity(
      record.manifestFile.sha256,
      `${record.manifest.bundler}-unresolved-manifest-${importKind}-import`,
      `${record.entry.key}:${specifier}`,
    ),
    observations: [
      {
        label: specifier,
        properties: {
          semantic_role: "bundler-manifest-chunk-reference",
          bundler: record.manifest.bundler,
          manifest_kind: record.manifest.manifest_kind,
          entry_key: record.entry.key,
          specifier,
          resolution_status: "not-found",
        },
        evidence: staticInferenceEvidence({
          sha256: record.manifestFile.sha256,
          path: record.manifest.path,
          operation: "retain-unresolved-bundler-manifest-import",
          coverage: record.coverage,
          confidence: "low",
        }),
      },
    ],
  });

const unresolvedManifestAssetNode = (
  context: JavaScriptArtifactGraphContext,
  record: ManifestEntryRecord,
  specifier: string,
  resolvedPath: string | null,
): ApplicationNode =>
  context.accumulator.addNode({
    kind: "artifact",
    identity: artifactLocalIdentity(
      record.manifestFile.sha256,
      `${record.manifest.bundler}-manifest-asset-reference`,
      `${record.entry.key}:${specifier}`,
    ),
    observations: [
      {
        label: specifier,
        properties: {
          semantic_role: "bundler-manifest-asset-reference",
          bundler: record.manifest.bundler,
          manifest_kind: record.manifest.manifest_kind,
          entry_key: record.entry.key,
          specifier,
          resolved_path: resolvedPath,
          resolution_status: "not-found",
        },
        evidence: staticInferenceEvidence({
          sha256: record.manifestFile.sha256,
          path: record.manifest.path,
          operation: "retain-unresolved-bundler-manifest-asset",
          coverage: record.coverage,
          confidence: "low",
        }),
      },
    ],
  });

const resolveManifestTargetPath = (
  context: JavaScriptArtifactGraphContext,
  manifest: JavaScriptBundlerManifestObservation,
  specifier: string,
): string | null => {
  for (const candidate of manifestPathCandidates(manifest, specifier))
    if (context.filesByPath.has(candidate)) return candidate;
  return null;
};

const manifestPathCandidates = (
  manifest: JavaScriptBundlerManifestObservation,
  specifier: string,
): readonly string[] => {
  const normalized = normalizeManifestSpecifier(specifier);
  if (normalized === null) return [];
  const base = manifestBasePath(manifest);
  return [
    normalized,
    base === "" ? normalized : normalizeJoinedPath(base, normalized),
  ].filter((value, index, values) => values.indexOf(value) === index);
};

const manifestBasePath = (
  manifest: JavaScriptBundlerManifestObservation,
): string => {
  const directory = posix.dirname(manifest.path);
  const base =
    manifest.manifest_kind === "vite-manifest" &&
    posix.basename(directory) === ".vite"
      ? posix.dirname(directory)
      : directory;
  return base === "." ? "" : base;
};

const normalizeJoinedPath = (base: string, specifier: string): string =>
  normalizeManifestSpecifier(posix.join(base, specifier)) ?? specifier;

const normalizeManifestSpecifier = (specifier: string): string | null => {
  const stripped = specifier.replace(/^\/+/u, "");
  const normalized = posix.normalize(stripped).replace(/^\.\//u, "");
  return normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
    ? null
    : normalized;
};

const manifestCoverage = (
  manifest: JavaScriptBundlerManifestObservation,
): JavaScriptArtifactGraphCoverage =>
  manifest.status === "included"
    ? completeReconstructionCoverage()
    : partialReconstructionCoverage(
        [
          {
            name: "max-findings",
            value: manifest.entries.length,
            unit: "items",
          },
        ],
        manifest.omitted_entries,
        true,
      );
