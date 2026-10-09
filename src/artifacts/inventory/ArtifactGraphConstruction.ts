import { compareCodePoints } from "../../domain/canonicalOrdering.js";
import { canonicalDigest } from "../../domain/comparisonSemantics.js";
import {
  artifactEdgeId,
  artifactIdForContent,
  occurrenceIdForLocation,
} from "../../domain/artifactIdentity.js";
import type { ArtifactEntry } from "../ArtifactReader.js";
import type {
  ArtifactCommand,
  ArtifactEdge,
  ArtifactNode,
  ArtifactOccurrence,
} from "../../domain/artifactGraph.js";
import {
  hasZipSignature,
  zipPackageFormatForPath,
} from "../../domain/zipPackageFormat.js";
import { mzWindowsHeaderOffset, parseDosMzHeader } from "../../domain/dosMz.js";

/** Mutable internal occurrence used until root-bound IDs are known. */
export interface MutableOccurrence {
  occurrence_id: string;
  artifact_id: string | null;
  parent_occurrence_id: string | null;
  logical_path: string;
  entry_kind: ArtifactOccurrence["entry_kind"];
  artifact_kind: ArtifactOccurrence["artifact_kind"];
  artifact_format: ArtifactOccurrence["artifact_format"];
  declared_size: number | null;
  compressed_size: number | null;
  executable: boolean;
  encrypted: boolean;
  hash_status: ArtifactOccurrence["hash_status"];
  source_location: ArtifactOccurrence["source_location"];
  limitations: string[];
}

/** Index the first occurrence for each canonical logical path. */
export const indexOccurrencesByPath = (
  occurrences: readonly MutableOccurrence[],
): ReadonlyMap<string, MutableOccurrence> => {
  const byPath = new Map<string, MutableOccurrence>();
  for (const occurrence of occurrences)
    if (!byPath.has(occurrence.logical_path))
      byPath.set(occurrence.logical_path, occurrence);
  return byPath;
};

export const createOccurrence = (
  entry: ArtifactEntry,
  path: string,
  parent: string | null,
): MutableOccurrence => ({
  occurrence_id: `occ_${canonicalDigest({ path, kind: entry.kind }, "Artifact")}`,
  artifact_id: null,
  parent_occurrence_id: parent,
  logical_path: path,
  entry_kind: entry.kind,
  artifact_kind:
    entry.kind === "directory"
      ? path.toLowerCase().endsWith(".framework")
        ? "framework"
        : "container"
      : classifyArtifactPath(path).kind,
  artifact_format:
    entry.kind === "directory"
      ? "directory"
      : classifyArtifactPath(path).format,
  declared_size: entry.declaredSize,
  compressed_size: entry.compressedSize,
  executable: entry.executable,
  encrypted: entry.encrypted,
  hash_status: entry.encrypted ? "unavailable" : "not-hashed",
  source_location:
    entry.byteOffset === null || entry.declaredSize === null
      ? null
      : { offset: entry.byteOffset, length: entry.declaredSize },
  limitations: [...entry.limitations],
});

/** Compare exact child names independently of host locale and traversal order. */
export const compareDirectoryChildNames = compareCodePoints;

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
        // Intermediate directory entries may be absent from an archive.
        name: logical_path.slice(directory.logical_path.length + 1),
        artifact_id,
        entry_kind,
      }))
      .sort((left, right) => compareDirectoryChildNames(left.name, right.name));
    const node = createArtifactNode({
      sha256: canonicalDigest({ kind: "directory", children }, "Artifact"),
      size: 0,
      format: "directory",
      contentState: "virtual",
    });
    nodes.set(node.artifact_id, node);
    directory.artifact_id = node.artifact_id;
    directory.hash_status = "verified";
  }
};

export const createRootNode = (input: {
  readonly digest: {
    readonly sha256: string;
    readonly bytes: number;
    readonly prefix: Buffer;
  } | null;
  readonly occurrences: readonly MutableOccurrence[];
}): ArtifactNode =>
  createArtifactNode({
    sha256:
      input.digest?.sha256 ??
      canonicalDigest(
        {
          kind: "directory-root",
          children: input.occurrences
            .map(({ logical_path, artifact_id }) => ({
              logical_path,
              artifact_id,
            }))
            .sort((left, right) =>
              compareDirectoryChildNames(left.logical_path, right.logical_path),
            ),
        },
        "Artifact",
      ),
    size: input.digest?.bytes ?? 0,
    format:
      input.digest === null
        ? "directory"
        : classifyArtifactBytes(input.digest.prefix, input.digest.bytes),
    contentState: "materialized",
  });

export const createArtifactNode = (input: {
  readonly sha256: string;
  readonly size: number;
  readonly format: ArtifactNode["format"];
  readonly contentState: ArtifactNode["content_state"];
}): ArtifactNode => ({
  artifact_id: artifactIdForContent(input.sha256),
  format: input.format,
  sha256: input.sha256,
  size: input.size,
  media_type: null,
  architecture: null,
  content_state: input.contentState,
  limitations: [],
});

export const rootOccurrenceFor = (
  node: ArtifactNode,
  metadata: {
    readonly size: number;
    readonly executable: boolean;
    readonly format: ArtifactOccurrence["artifact_format"];
    readonly path: string;
  },
): MutableOccurrence => ({
  occurrence_id: occurrenceIdForLocation({
    rootArtifactId: node.artifact_id,
    logicalPath: ".",
    entryKind: metadata.format === "directory" ? "directory" : "file",
  }),
  artifact_id: node.artifact_id,
  parent_occurrence_id: null,
  logical_path: ".",
  entry_kind: metadata.format === "directory" ? "directory" : "file",
  artifact_kind:
    metadata.format === "directory" ||
    ["zip", "ipa", "apk", "msix", "appx", "asar", "dmg", "pkg"].includes(
      metadata.format,
    )
      ? "container"
      : artifactRoleForFormat(metadata.path, metadata.format).kind,
  artifact_format: metadata.format,
  declared_size: metadata.size,
  compressed_size: null,
  executable: metadata.executable,
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
      occurrenceIdForLocation({
        rootArtifactId,
        logicalPath: occurrence.logical_path,
        entryKind: occurrence.entry_kind,
      }),
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
  const byPath = indexOccurrencesByPath(occurrences);
  const edges: ArtifactEdge[] = [];
  for (const occurrence of occurrences) {
    if (
      occurrence.parent_occurrence_id === null ||
      occurrence.artifact_id === null
    )
      continue;
    const mappedSource = occurrence.logical_path.toLowerCase().endsWith(".map")
      ? byPath.get(occurrence.logical_path.slice(0, -".map".length))
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
      edge_id: artifactEdgeId(semantic),
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
  expandedContainerIds: ReadonlySet<string>,
): MutableOccurrence | undefined => {
  const parts = path.split("/");
  while (parts.length > 1) {
    parts.pop();
    const candidate = occurrences.get(parts.join("/"));
    if (
      candidate !== undefined &&
      (candidate.entry_kind === "directory" ||
        expandedContainerIds.has(candidate.occurrence_id))
    )
      return candidate;
  }
  return undefined;
};

export const classifyArtifactPath = (
  path: string,
): {
  readonly kind: ArtifactOccurrence["artifact_kind"];
  readonly format: ArtifactOccurrence["artifact_format"];
} => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".map"))
    return { kind: "source-map", format: "source-map" };
  if (/\.(?:m?js|cjs)$/u.test(lower))
    return { kind: "javascript", format: "javascript-bundle" };
  if (lower.endsWith(".asar")) return { kind: "container", format: "asar" };
  const archiveFormat = zipPackageFormatForPath(lower);
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
  fileSize = prefix.length,
): {
  readonly kind: ArtifactOccurrence["artifact_kind"];
  readonly format: ArtifactOccurrence["artifact_format"];
} => {
  return artifactRoleForFormat(path, classifyArtifactBytes(prefix, fileSize));
};

const artifactRoleForFormat = (
  path: string,
  format: ArtifactOccurrence["artifact_format"],
): ReturnType<typeof classifyArtifactPath> => {
  const byPath = classifyArtifactPath(path);
  if (format === "file" || format === byPath.format) return byPath;
  if (format === "unknown") return { kind: "unknown", format };
  if (format === "zip")
    return {
      kind: "container",
      format: zipPackageFormatForPath(path) ?? format,
    };
  if (format === "plist") return { kind: "plist", format };
  return {
    kind: ["native-addon", "dynamic-library"].includes(byPath.kind)
      ? byPath.kind
      : ("executable" as const),
    format,
  };
};

/** Classify storage bytes independently of path names, roles, and permissions. */
export const classifyArtifactBytes = (
  prefix: Buffer,
  fileSize = prefix.length,
): ArtifactNode["format"] => {
  if (hasZipSignature(prefix)) return "zip";
  if (prefix.subarray(0, 8).equals(Buffer.from("bplist00"))) return "plist";
  if (prefix.length >= 4) {
    const magic = prefix.readUInt32BE(0);
    if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
      return "mach-o-universal";
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
      return "mach-o";
    if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      return "elf";
  }
  if (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a) {
    if (
      !Number.isSafeInteger(fileSize) ||
      fileSize < prefix.length ||
      prefix.length < Math.min(fileSize, 64)
    )
      return "unknown";
    const windowsOffset = mzWindowsHeaderOffset(prefix);
    if (windowsOffset !== null) {
      if (
        windowsOffset >= 64 &&
        windowsOffset <= prefix.length - 4 &&
        prefix
          .subarray(windowsOffset, windowsOffset + 4)
          .equals(Buffer.from([0x50, 0x45, 0, 0]))
      )
        return "pe";
    } else if (parseDosMzHeader(prefix, fileSize).ok) return "dos-mz";
    return "unknown";
  }
  return "file";
};

const relationFor = (path: string): ArtifactEdge["relation"] => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".map")) return "maps-source";
  if (lower.includes(".framework/")) return "embeds";
  return "contains";
};

const depth = (path: string): number => path.split("/").length;
