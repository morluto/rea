import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { Readable } from "node:stream";

import { AsarArtifactReader } from "../artifacts/AsarArtifactReader.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../artifacts/ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactLimits,
  type ArtifactReader,
} from "../artifacts/ArtifactReader.js";
import { DirectoryArtifactReader } from "../artifacts/DirectoryArtifactReader.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import { MachOSliceArtifactReader } from "../artifacts/MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "../artifacts/NativeDmgArtifactReader.js";
import { streamChunkToBuffer } from "../artifacts/StreamBytes.js";
import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
  type ArtifactNode,
  type IntegrityContradiction,
} from "../domain/artifactGraph.js";
import {
  classifyArtifactPath,
  classifyArtifactContent,
  createArtifactEdges,
  createArtifactNode,
  createOccurrence,
  createRootNode,
  digestCanonical,
  indexOccurrencesByPath,
  materializeDirectoryNodes,
  nearestParent,
  pageOf,
  rekeyOccurrences,
  rootOccurrenceFor,
  toOutputLimits,
  type MutableOccurrence,
} from "./ArtifactGraphConstruction.js";

interface InventoryPageInput {
  readonly nodeOffset: number;
  readonly nodeLimit: number;
  readonly occurrenceOffset: number;
  readonly occurrenceLimit: number;
  readonly edgeOffset: number;
  readonly edgeLimit: number;
}

/** Per-request authority combined with operator-owned native mount policy. */
export interface ArtifactNativeMountPolicy {
  readonly nativeMountApproved: boolean;
  readonly nativeMountEnabled: boolean;
}

const NATIVE_MOUNT_DISABLED: ArtifactNativeMountPolicy = {
  nativeMountApproved: false,
  nativeMountEnabled: false,
};

/** Explicit caller approval bounded by operator-owned integrity policy. */
export interface ArtifactIntegrityPolicy {
  readonly mode: "fail" | "record-and-continue";
  readonly approved: boolean;
  readonly enabled: boolean;
  readonly maxMismatches: number;
}

const STRICT_INTEGRITY_POLICY: ArtifactIntegrityPolicy = {
  mode: "fail",
  approved: false,
  enabled: false,
  maxMismatches: 1,
};

/** Immutable inventory produced by one complete artifact scan. */
export interface ArtifactInventorySnapshot {
  readonly manifest: ArtifactInventoryResult["manifest"];
  readonly nodes: readonly ArtifactNode[];
  readonly occurrences: ArtifactInventoryResult["occurrences"]["items"];
  readonly edges: ArtifactInventoryResult["edges"]["items"];
  readonly limits: ArtifactInventoryResult["limits"];
  readonly provenance: ReadonlyArray<
    ArtifactInventoryResult["provenance"][number]
  >;
  readonly integrity_contradictions: readonly IntegrityContradiction[];
  readonly limitations: readonly string[];
}

/** Inventory one local artifact without extracting or mounting it. */
export const inventoryArtifact = async (
  inputPath: string,
  limits: ArtifactLimits,
  page: InventoryPageInput,
  options: {
    readonly signal?: AbortSignal;
    readonly nativeMount?: ArtifactNativeMountPolicy;
    readonly integrity?: ArtifactIntegrityPolicy;
  } = {},
): Promise<ArtifactInventoryResult> => {
  const snapshot = await scanArtifactInventory(
    inputPath,
    limits,
    options.signal,
    options.nativeMount ?? NATIVE_MOUNT_DISABLED,
    options.integrity ?? STRICT_INTEGRITY_POLICY,
  );
  return paginateArtifactInventory(snapshot, page);
};

/** Scan an artifact once and retain the complete immutable graph for projection. */
export const scanArtifactInventory = async (
  inputPath: string,
  limits: ArtifactLimits,
  signal?: AbortSignal,
  nativeMount: ArtifactNativeMountPolicy = NATIVE_MOUNT_DISABLED,
  integrity: ArtifactIntegrityPolicy = STRICT_INTEGRITY_POLICY,
): Promise<ArtifactInventorySnapshot> => {
  abortIfNeeded(signal);
  const path = await realpath(inputPath);
  return scanCanonicalArtifactInventory(
    path,
    limits,
    signal,
    nativeMount,
    integrity,
  );
};

/** Scan one already-canonical artifact path without resolving it again. */
export const scanCanonicalArtifactInventory = async (
  path: string,
  limits: ArtifactLimits,
  signal?: AbortSignal,
  nativeMount: ArtifactNativeMountPolicy = NATIVE_MOUNT_DISABLED,
  integrity: ArtifactIntegrityPolicy = STRICT_INTEGRITY_POLICY,
): Promise<ArtifactInventorySnapshot> => {
  if (
    integrity.mode === "record-and-continue" &&
    (!integrity.approved || !integrity.enabled)
  )
    throw new ArtifactReaderFailure(
      "unavailable",
      "Integrity continuation requires explicit approval and operator policy",
    );
  const metadata = await lstat(path);
  const rootFormat = await classifyRoot(path, metadata.isDirectory());
  const rootDigest = metadata.isDirectory()
    ? null
    : await hashReadable(createReadStream(path), limits.maxTotalBytes, signal);
  const reader = await createReader(path, rootFormat, nativeMount, signal);

  try {
    const { nodes, occurrences, pendingContradictions } = await scanReader(
      reader,
      limits,
      signal,
      integrity,
    );

    materializeDirectoryNodes(occurrences, nodes);
    const rootNode = createRootNode({
      path,
      format: rootFormat,
      directory: metadata.isDirectory(),
      digest: rootDigest,
      occurrences,
    });
    nodes.set(rootNode.artifact_id, rootNode);
    rekeyOccurrences(rootNode.artifact_id, occurrences);
    const rootOccurrence = rootOccurrenceFor(rootNode, metadata.size);
    for (const occurrence of occurrences)
      if (occurrence.parent_occurrence_id === null)
        occurrence.parent_occurrence_id = rootOccurrence.occurrence_id;
    occurrences.unshift(rootOccurrence);
    const occurrenceById = new Map(
      occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]),
    );
    const occurrenceByPath = indexOccurrencesByPath(occurrences);
    const integrityContradictions = pendingContradictions.map(
      (contradiction): IntegrityContradiction => {
        const occurrence = occurrenceByPath.get(contradiction.logicalPath);
        if (occurrence === undefined)
          throw new ArtifactReaderFailure(
            "integrity",
            "Integrity contradiction lost its graph occurrence",
          );
        const parent =
          occurrence.parent_occurrence_id === null
            ? undefined
            : occurrenceById.get(occurrence.parent_occurrence_id);
        const parentArtifactId = parent?.artifact_id ?? rootNode.artifact_id;
        return {
          contradiction_id: `ic_${digestCanonical({
            root_artifact_id: rootNode.artifact_id,
            logical_path: contradiction.logicalPath,
            declared_sha256: contradiction.declaredSha256,
            observed_sha256: contradiction.observedSha256,
          })}`,
          occurrence_id: occurrence.occurrence_id,
          parent_artifact_id: parentArtifactId,
          logical_path: contradiction.logicalPath,
          declared_sha256: contradiction.declaredSha256,
          observed_sha256: contradiction.observedSha256,
          entry_kind: contradiction.entryKind,
          unpacked: contradiction.unpacked,
          trust: "observed-untrusted",
          provenance: "container-integrity-metadata-versus-observed-bytes",
          limitations: [
            "Observed bytes contradict declared integrity metadata and cannot support equivalence.",
          ],
        };
      },
    );
    const edges = createArtifactEdges(
      rootNode.artifact_id,
      occurrences,
      reader?.provenance()[0],
    );
    const orderedNodes = [...nodes.values()].sort((left, right) =>
      left.artifact_id.localeCompare(right.artifact_id),
    );
    const orderedOccurrences = occurrences.sort((left, right) =>
      left.logical_path.localeCompare(right.logical_path, "en"),
    );
    const orderedEdges = edges.sort((left, right) =>
      left.edge_id.localeCompare(right.edge_id),
    );
    if (rootDigest !== null) {
      const verified = await hashReadable(
        createReadStream(path),
        limits.maxTotalBytes,
        signal,
      );
      if (
        verified.sha256 !== rootDigest.sha256 ||
        verified.bytes !== rootDigest.bytes
      )
        throw new ArtifactReaderFailure(
          "integrity",
          "Root artifact changed during inventory",
        );
    }
    const graphSha256 = digestCanonical({
      nodes: orderedNodes,
      occurrences: orderedOccurrences,
      edges: orderedEdges,
      integrity_contradictions: integrityContradictions,
    });
    const manifestId = `agm_${digestCanonical({
      schema_version: 1,
      root_artifact_id: rootNode.artifact_id,
      graph_sha256: graphSha256,
    })}`;
    return {
      manifest: artifactInventoryResultSchema.shape.manifest.parse({
        schema_version: 1,
        manifest_id: manifestId,
        root_artifact_id: rootNode.artifact_id,
        root_sha256: rootNode.sha256,
        root_format: rootNode.format,
        graph_sha256: graphSha256,
        node_count: orderedNodes.length,
        occurrence_count: orderedOccurrences.length,
        edge_count: orderedEdges.length,
      }),
      nodes: orderedNodes,
      occurrences: orderedOccurrences,
      edges: orderedEdges,
      limits: toOutputLimits(limits),
      provenance: reader?.provenance() ?? [],
      integrity_contradictions: integrityContradictions,
      limitations: [
        ...inventoryLimitations(rootFormat, reader),
        ...(integrityContradictions.length === 0
          ? []
          : [
              `${String(integrityContradictions.length)} integrity contradiction(s) were recorded; mismatched content is observed-untrusted.`,
            ]),
      ],
    };
  } finally {
    await reader?.close();
  }
};

/** Project independently paged graph collections from one inventory snapshot. */
export const paginateArtifactInventory = (
  snapshot: ArtifactInventorySnapshot,
  page: InventoryPageInput,
): ArtifactInventoryResult =>
  artifactInventoryResultSchema.parse({
    ...snapshot,
    nodes: pageOf(snapshot.nodes, page.nodeOffset, page.nodeLimit),
    occurrences: pageOf(
      snapshot.occurrences,
      page.occurrenceOffset,
      page.occurrenceLimit,
    ),
    edges: pageOf(snapshot.edges, page.edgeOffset, page.edgeLimit),
  });

const inventoryLimitations = (
  format: ArtifactNode["format"],
  reader: ArtifactReader | undefined,
): string[] => {
  if (reader !== undefined) return [];
  if (format === "dmg" || format === "pkg")
    return [
      `${format.toUpperCase()} root hash is observed; child inventory requires an approved native macOS adapter.`,
    ];
  if (format === "mach-o-universal" && process.platform !== "darwin")
    return ["Universal Mach-O slices require the native macOS lipo adapter."];
  return ["Artifact has no child container entries."];
};

const createReader = async (
  path: string,
  format: ArtifactNode["format"],
  nativeMount: ArtifactNativeMountPolicy,
  signal?: AbortSignal,
): Promise<ArtifactReader | undefined> => {
  switch (format) {
    case "directory":
      return new DirectoryArtifactReader(path);
    case "zip":
    case "ipa":
    case "apk":
      return new ZipArtifactReader(path, format);
    case "asar":
      return new AsarArtifactReader(path);
    case "mach-o-universal":
      return process.platform === "darwin"
        ? new MachOSliceArtifactReader(path)
        : undefined;
    case "dmg":
      if (!nativeMount.nativeMountApproved) return undefined;
      if (!nativeMount.nativeMountEnabled)
        throw new ArtifactReaderFailure(
          "unavailable",
          "Native DMG mounting is disabled by operator policy",
        );
      return NativeDmgArtifactReader.create(path, signal);
    default:
      return undefined;
  }
};

const visitNestedAsar = async (
  adapterKey: string,
  logicalPath: string,
  visit: (reader: ArtifactReader, prefix: string) => Promise<void>,
): Promise<void> => {
  const nested = new AsarArtifactReader(adapterKey);
  try {
    await visit(nested, logicalPath);
  } finally {
    await nested.close();
  }
};

const isExpandableAsar = (entry: ArtifactEntry, logicalPath: string): boolean =>
  entry.kind === "file" &&
  logicalPath.toLowerCase().endsWith(".asar") &&
  entry.adapterKey.startsWith("/");

const emptyScan = (): {
  readonly nodes: Map<string, ArtifactNode>;
  readonly occurrences: MutableOccurrence[];
  readonly pendingContradictions: PendingIntegrityContradiction[];
} => ({ nodes: new Map(), occurrences: [], pendingContradictions: [] });

const UNAVAILABLE_UNPACKED_LIMITATION =
  "ASAR unpacked companion bytes were unavailable; no content hash or child artifact was produced.";

interface PendingIntegrityContradiction {
  readonly logicalPath: string;
  readonly declaredSha256: string;
  readonly observedSha256: string;
  readonly entryKind: "file" | "slice";
  readonly unpacked: boolean;
}

const scanReader = async (
  reader: ArtifactReader | undefined,
  limits: ArtifactLimits,
  signal?: AbortSignal,
  integrity: ArtifactIntegrityPolicy = STRICT_INTEGRITY_POLICY,
): Promise<{
  readonly nodes: Map<string, ArtifactNode>;
  readonly occurrences: MutableOccurrence[];
  readonly pendingContradictions: PendingIntegrityContradiction[];
}> => {
  const { nodes, occurrences, pendingContradictions } = emptyScan();
  if (reader === undefined)
    return { nodes, occurrences, pendingContradictions };
  const occurrenceByPath = new Map<string, MutableOccurrence>();
  const registry = new ArtifactPathRegistry();
  let totalBytes = 0;
  const digestEntry = async (
    currentReader: ArtifactReader,
    entry: ArtifactEntry,
    logicalPath: string,
  ): Promise<
    { readonly node: ArtifactNode; readonly mismatched: boolean } | undefined
  > => {
    if ((entry.kind !== "file" && entry.kind !== "slice") || entry.encrypted)
      return undefined;
    const remainingBytes = limits.maxTotalBytes - totalBytes;
    if (remainingBytes <= 0)
      throw new ArtifactReaderFailure(
        "limit",
        "Artifact total byte limit exceeded",
      );
    if (entry.declaredSize !== null && entry.declaredSize > remainingBytes)
      throw new ArtifactReaderFailure(
        "limit",
        "Declared artifact bytes exceed remaining cumulative limit",
      );
    const digest = await hashReadable(
      await currentReader.open(entry, signal),
      Math.min(limits.maxEntryBytes, remainingBytes),
      signal,
    );
    totalBytes += digest.bytes;
    const mismatched =
      entry.declaredSha256 !== null && entry.declaredSha256 !== digest.sha256;
    if (mismatched && integrity.mode === "fail")
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact integrity metadata disagrees with content: ${logicalPath}`,
        undefined,
        {
          logicalPath,
          declaredSha256: entry.declaredSha256,
          calculatedSha256: digest.sha256,
          unpacked: entry.unpacked,
        },
      );
    if (mismatched && entry.declaredSha256 !== null) {
      if (pendingContradictions.length >= integrity.maxMismatches)
        throw new ArtifactReaderFailure(
          "limit",
          "Artifact integrity mismatch limit exceeded",
        );
      pendingContradictions.push({
        logicalPath,
        declaredSha256: entry.declaredSha256,
        observedSha256: digest.sha256,
        entryKind: entry.kind,
        unpacked: entry.unpacked,
      });
    }
    const classified =
      entry.kind === "slice"
        ? ({ kind: "universal-slice", format: "mach-o" } as const)
        : classifyArtifactContent(logicalPath, digest.prefix);
    return {
      node: createArtifactNode({
        sha256: digest.sha256,
        size: digest.bytes,
        kind: classified.kind,
        format: classified.format,
        executable: entry.executable,
        contentState: "embedded",
        limitations: mismatched
          ? [
              "Observed content contradicts declared integrity metadata and is untrusted.",
            ]
          : [],
      }),
      mismatched,
    };
  };
  const visit = async (
    currentReader: ArtifactReader,
    prefix: string,
  ): Promise<void> => {
    for await (const entry of currentReader.entries(signal)) {
      if (occurrences.length >= limits.maxEntries)
        throw new ArtifactReaderFailure(
          "limit",
          "Artifact entry limit exceeded",
        );
      const logicalPath = normalizeArtifactPath(
        prefix.length === 0 ? entry.path : `${prefix}/${entry.path}`,
        limits,
      );
      const expandableAsar = isExpandableAsar(entry, logicalPath);
      registry.add(logicalPath, expandableAsar ? "directory" : entry.kind);
      preflightEntry(entry, limits);
      const parent = nearestParent(logicalPath, occurrenceByPath);
      const occurrence = createOccurrence(
        entry,
        logicalPath,
        parent?.occurrence_id ?? null,
      );
      let digested:
        | { readonly node: ArtifactNode; readonly mismatched: boolean }
        | undefined;
      try {
        digested = await digestEntry(currentReader, entry, logicalPath);
      } catch (cause: unknown) {
        if (!isUnavailableUnpackedEntry(cause, entry)) throw cause;
        occurrence.hash_status = "unavailable";
        occurrence.limitations.push(UNAVAILABLE_UNPACKED_LIMITATION);
      }
      if (digested !== undefined) {
        nodes.set(digested.node.artifact_id, digested.node);
        occurrence.artifact_id = digested.node.artifact_id;
        occurrence.hash_status = digested.mismatched
          ? "mismatched"
          : "verified";
        if (digested.mismatched)
          occurrence.limitations.push(
            "Declared integrity metadata contradicts observed bytes.",
          );
      }
      occurrences.push(occurrence);
      occurrenceByPath.set(logicalPath, occurrence);
      if (expandableAsar && digested?.mismatched !== true)
        await visitNestedAsar(entry.adapterKey, logicalPath, visit);
    }
  };
  await visit(reader, "");
  return { nodes, occurrences, pendingContradictions };
};

const isUnavailableUnpackedEntry = (
  cause: unknown,
  entry: ArtifactEntry,
): boolean =>
  entry.unpacked &&
  cause instanceof ArtifactReaderFailure &&
  cause.reason === "unavailable";

const classifyRoot = async (
  path: string,
  directory: boolean,
): Promise<ArtifactNode["format"]> => {
  if (directory) return "directory";
  const extensionFormat = classifyContainerExtension(path);
  if (extensionFormat !== undefined) return extensionFormat;
  const handle = await open(path, "r");
  try {
    const magic = Buffer.alloc(4);
    const observed = await handle.read(magic, 0, magic.length, 0);
    if (
      observed.bytesRead === 4 &&
      magic[0] === 0x50 &&
      magic[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(magic[2] ?? -1) &&
      [0x04, 0x06, 0x08].includes(magic[3] ?? -1)
    )
      return "zip";
    if (observed.bytesRead === 4) {
      const header = magic.readUInt32BE(0);
      if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header))
        return "mach-o-universal";
      if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(header))
        return "mach-o";
      if (magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "elf";
    }
    if (observed.bytesRead >= 2 && magic[0] === 0x4d && magic[1] === 0x5a)
      return "pe";
  } finally {
    await handle.close();
  }
  return classifyArtifactPath(path).format;
};

const classifyContainerExtension = (
  path: string,
): ArtifactNode["format"] | undefined => {
  const lower = path.toLowerCase();
  for (const format of ["asar", "ipa", "apk", "zip", "dmg", "pkg"] as const)
    if (lower.endsWith(`.${format}`)) return format;
  return undefined;
};

const preflightEntry = (entry: ArtifactEntry, limits: ArtifactLimits): void => {
  if (entry.declaredSize !== null && entry.declaredSize > limits.maxEntryBytes)
    throw new ArtifactReaderFailure(
      "limit",
      `Entry exceeds byte limit: ${entry.path}`,
    );
  if (
    entry.declaredSize !== null &&
    entry.compressedSize !== null &&
    entry.compressedSize === 0 &&
    entry.declaredSize > 0
  )
    throw new ArtifactReaderFailure(
      "limit",
      `Invalid compression ratio: ${entry.path}`,
    );
  if (
    entry.declaredSize !== null &&
    entry.compressedSize !== null &&
    entry.compressedSize > 0 &&
    entry.declaredSize / entry.compressedSize > limits.maxCompressionRatio
  )
    throw new ArtifactReaderFailure(
      "limit",
      `Compression ratio exceeds limit: ${entry.path}`,
    );
};

const hashReadable = async (
  stream: Readable,
  maximum: number,
  signal?: AbortSignal,
): Promise<{
  readonly sha256: string;
  readonly bytes: number;
  readonly prefix: Buffer;
}> => {
  const hash = createHash("sha256");
  const prefixes: Buffer[] = [];
  let prefixBytes = 0;
  let bytes = 0;
  for await (const raw of stream) {
    abortIfNeeded(signal);
    const chunk = streamChunkToBuffer(raw);
    bytes += chunk.length;
    if (bytes > maximum) {
      stream.destroy();
      throw new ArtifactReaderFailure(
        "limit",
        "Observed entry bytes exceed limit",
      );
    }
    hash.update(chunk);
    if (prefixBytes < 16) {
      const selected = chunk.subarray(0, 16 - prefixBytes);
      prefixes.push(selected);
      prefixBytes += selected.length;
    }
  }
  return { sha256: hash.digest("hex"), bytes, prefix: Buffer.concat(prefixes) };
};

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact inventory cancelled",
    );
};
