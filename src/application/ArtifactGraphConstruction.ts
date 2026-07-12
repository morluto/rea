import { createHash } from "node:crypto";
import { extname } from "node:path";

import canonicalize from "canonicalize";

import type {
  ArtifactEntry,
  ArtifactLimits,
} from "../artifacts/ArtifactReader.js";
import type {
  ArtifactCommand,
  ArtifactEdge,
  ArtifactNode,
  ArtifactOccurrence,
} from "../domain/artifactGraph.js";

/** Mutable internal occurrence used until root-bound IDs are known. */
export interface MutableOccurrence {
  occurrence_id: string;
  artifact_id: string | null;
  parent_occurrence_id: string | null;
  logical_path: string;
  entry_kind: ArtifactOccurrence["entry_kind"];
  declared_size: number | null;
  compressed_size: number | null;
  executable: boolean;
  encrypted: boolean;
  hash_status: ArtifactOccurrence["hash_status"];
  source_location: ArtifactOccurrence["source_location"];
  limitations: string[];
}

export const createOccurrence = (
  entry: ArtifactEntry,
  path: string,
  parent: string | null,
): MutableOccurrence => ({
  occurrence_id: `occ_${digestCanonical({ path, kind: entry.kind })}`,
  artifact_id: null,
  parent_occurrence_id: parent,
  logical_path: path,
  entry_kind: entry.kind,
  declared_size: entry.declaredSize,
  compressed_size: entry.compressedSize,
  executable: entry.executable,
  encrypted: entry.encrypted,
  hash_status: entry.encrypted ? "unavailable" : "not-hashed-limit",
  source_location:
    entry.byteOffset === null || entry.declaredSize === null
      ? null
      : { offset: entry.byteOffset, length: entry.declaredSize },
  limitations: [...entry.limitations],
});

export const materializeDirectoryNodes = (
  occurrences: MutableOccurrence[],
  nodes: Map<string, ArtifactNode>,
): void => {
  const directories = occurrences
    .filter(({ entry_kind: kind }) => kind === "directory")
    .sort(
      (left, right) => depth(right.logical_path) - depth(left.logical_path),
    );
  const childrenByParent = new Map<string, MutableOccurrence[]>();
  for (const occurrence of occurrences) {
    if (occurrence.parent_occurrence_id === null) continue;
    const children = childrenByParent.get(occurrence.parent_occurrence_id);
    if (children === undefined)
      childrenByParent.set(occurrence.parent_occurrence_id, [occurrence]);
    else children.push(occurrence);
  }
  for (const directory of directories) {
    const children = (childrenByParent.get(directory.occurrence_id) ?? [])
      .map(({ logical_path, artifact_id, entry_kind }) => ({
        name: logical_path.split("/").at(-1),
        artifact_id,
        entry_kind,
      }))
      .sort((left, right) =>
        String(left.name).localeCompare(String(right.name)),
      );
    const node = createArtifactNode({
      sha256: digestCanonical({ kind: "directory", children }),
      size: 0,
      kind: directory.logical_path.toLowerCase().endsWith(".framework")
        ? "framework"
        : "container",
      format: "directory",
      executable: false,
      contentState: "virtual",
    });
    const existing = nodes.get(node.artifact_id);
    nodes.set(
      node.artifact_id,
      existing?.kind === "framework" ? existing : node,
    );
    directory.artifact_id = node.artifact_id;
    directory.hash_status = "verified";
  }
};

export const createRootNode = (input: {
  readonly path: string;
  readonly format: ArtifactNode["format"];
  readonly directory: boolean;
  readonly digest: { readonly sha256: string; readonly bytes: number } | null;
  readonly occurrences: readonly MutableOccurrence[];
}): ArtifactNode =>
  createArtifactNode({
    sha256:
      input.digest?.sha256 ??
      digestCanonical({
        kind: "directory-root",
        children: input.occurrences.map(({ logical_path, artifact_id }) => ({
          logical_path,
          artifact_id,
        })),
      }),
    size: input.digest?.bytes ?? 0,
    kind:
      input.directory ||
      ["zip", "ipa", "apk", "asar", "dmg", "pkg"].includes(input.format)
        ? "container"
        : classifyArtifactPath(input.path).kind,
    format: input.format,
    executable: false,
    contentState: "materialized",
  });

export const createArtifactNode = (input: {
  readonly sha256: string;
  readonly size: number;
  readonly kind: ArtifactNode["kind"];
  readonly format: ArtifactNode["format"];
  readonly executable: boolean;
  readonly contentState: ArtifactNode["content_state"];
}): ArtifactNode => ({
  artifact_id: `art_${digestCanonical({ schema_version: 1, sha256: input.sha256 })}`,
  kind: input.kind,
  format: input.format,
  sha256: input.sha256,
  size: input.size,
  media_type: null,
  architecture: null,
  executable: input.executable,
  content_state: input.contentState,
  limitations: [],
});

export const rootOccurrenceFor = (
  node: ArtifactNode,
  declaredSize: number,
): MutableOccurrence => ({
  occurrence_id: `occ_${digestCanonical({ root: node.artifact_id })}`,
  artifact_id: node.artifact_id,
  parent_occurrence_id: null,
  logical_path: ".",
  entry_kind: node.format === "directory" ? "directory" : "file",
  declared_size: declaredSize,
  compressed_size: null,
  executable: node.executable,
  encrypted: false,
  hash_status: "verified",
  source_location: null,
  limitations: [],
});

export const rekeyOccurrences = (
  rootArtifactId: string,
  occurrences: MutableOccurrence[],
): void => {
  const replacements = new Map<string, string>();
  for (const occurrence of occurrences)
    replacements.set(
      occurrence.occurrence_id,
      `occ_${digestCanonical({
        root_artifact_id: rootArtifactId,
        logical_path: occurrence.logical_path,
        entry_kind: occurrence.entry_kind,
      })}`,
    );
  for (const occurrence of occurrences) {
    occurrence.occurrence_id =
      replacements.get(occurrence.occurrence_id) ?? occurrence.occurrence_id;
    if (occurrence.parent_occurrence_id !== null)
      occurrence.parent_occurrence_id =
        replacements.get(occurrence.parent_occurrence_id) ??
        occurrence.parent_occurrence_id;
  }
};

export const createArtifactEdges = (
  rootArtifactId: string,
  occurrences: MutableOccurrence[],
  producer?: ArtifactCommand,
): ArtifactEdge[] => {
  const byId = new Map(occurrences.map((item) => [item.occurrence_id, item]));
  const edges: ArtifactEdge[] = [];
  for (const occurrence of occurrences) {
    if (
      occurrence.parent_occurrence_id === null ||
      occurrence.artifact_id === null
    )
      continue;
    const mappedSource = occurrence.logical_path.endsWith(".map")
      ? occurrences.find(
          ({ logical_path: path }) =>
            path === occurrence.logical_path.slice(0, -".map".length),
        )
      : undefined;
    const parentArtifactId =
      mappedSource?.artifact_id ??
      byId.get(occurrence.parent_occurrence_id)?.artifact_id ??
      rootArtifactId;
    const semantic = {
      parent_artifact_id: parentArtifactId,
      child_artifact_id: occurrence.artifact_id,
      relation:
        occurrence.entry_kind === "slice"
          ? ("slice-of" as const)
          : relationFor(occurrence.logical_path),
      occurrence_id: occurrence.occurrence_id,
      logical_path: occurrence.logical_path,
    };
    edges.push({
      edge_id: `edge_${digestCanonical(semantic)}`,
      ...semantic,
      producer: occurrence.entry_kind === "slice" ? (producer ?? null) : null,
      ordinal: edges.length,
    });
  }
  return edges;
};

export const nearestParent = (
  path: string,
  occurrences: ReadonlyMap<string, MutableOccurrence>,
): MutableOccurrence | undefined => {
  const parts = path.split("/");
  while (parts.length > 1) {
    parts.pop();
    const candidate = occurrences.get(parts.join("/"));
    if (candidate?.entry_kind === "directory") return candidate;
  }
  return undefined;
};

export const classifyArtifactPath = (
  path: string,
): Pick<ArtifactNode, "kind" | "format"> => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".map"))
    return { kind: "source-map", format: "source-map" };
  if (/\.(?:m?js|cjs)$/u.test(lower))
    return { kind: "javascript", format: "javascript-bundle" };
  if (lower.endsWith(".asar")) return { kind: "container", format: "asar" };
  const archiveFormat = archiveFormatForExtension(extname(lower));
  if (archiveFormat !== undefined)
    return { kind: "container", format: archiveFormat };
  if (/\.framework(?:\/|$)/u.test(lower))
    return { kind: "framework", format: "file" };
  if (/\.(?:node|dylib|so)$/u.test(lower))
    return {
      kind: lower.endsWith(".node") ? "native-addon" : "dynamic-library",
      format: "file",
    };
  if (lower.endsWith(".plist")) return { kind: "plist", format: "plist" };
  if (lower.endsWith(".entitlements"))
    return { kind: "entitlements", format: "entitlements" };
  return { kind: "resource", format: "file" };
};

/** Classify executable formats from bytes while retaining path-specific roles. */
export const classifyArtifactContent = (
  path: string,
  prefix: Buffer,
): Pick<ArtifactNode, "kind" | "format"> => {
  const byPath = classifyArtifactPath(path);
  if (prefix.length >= 4) {
    const magic = prefix.readUInt32BE(0);
    if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
      return {
        kind: byPath.kind === "native-addon" ? "native-addon" : "executable",
        format: "mach-o-universal",
      };
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
      return {
        kind: ["native-addon", "dynamic-library"].includes(byPath.kind)
          ? byPath.kind
          : "executable",
        format: "mach-o",
      };
    if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      return {
        kind: ["native-addon", "dynamic-library"].includes(byPath.kind)
          ? byPath.kind
          : "executable",
        format: "elf",
      };
  }
  if (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a)
    return {
      kind: byPath.kind === "native-addon" ? "native-addon" : "executable",
      format: "pe",
    };
  return byPath;
};

export const pageOf = <Value>(
  items: readonly Value[],
  offset: number,
  limit: number,
) => ({
  items: items.slice(offset, offset + limit),
  offset,
  limit,
  total: items.length,
  next_offset: offset + limit < items.length ? offset + limit : null,
});

export const toOutputLimits = (limits: ArtifactLimits) => ({
  max_entries: limits.maxEntries,
  max_total_bytes: limits.maxTotalBytes,
  max_entry_bytes: limits.maxEntryBytes,
  max_compression_ratio: limits.maxCompressionRatio,
  max_depth: limits.maxDepth,
  max_path_bytes: limits.maxPathBytes,
});

export const digestCanonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Artifact value is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

const relationFor = (path: string): ArtifactEdge["relation"] => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".map")) return "maps-source";
  if (lower.includes(".framework/")) return "embeds";
  return "contains";
};

const archiveFormatForExtension = (
  extension: string,
): "zip" | "ipa" | "apk" | undefined => {
  switch (extension) {
    case ".zip":
      return "zip";
    case ".ipa":
      return "ipa";
    case ".apk":
      return "apk";
    default:
      return undefined;
  }
};

const depth = (path: string): number => path.split("/").length;
