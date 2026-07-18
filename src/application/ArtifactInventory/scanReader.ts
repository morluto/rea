import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../../artifacts/ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactLimits,
  type ArtifactReader,
} from "../../artifacts/ArtifactReader.js";
import { AsarArtifactReader } from "../../artifacts/AsarArtifactReader.js";
import type { ArtifactNode } from "../../domain/artifactGraph.js";
import {
  classifyArtifactContent,
  createArtifactNode,
  createOccurrence,
  nearestParent,
  type MutableOccurrence,
} from "../ArtifactGraphConstruction.js";
import {
  STRICT_INTEGRITY_POLICY,
  type ArtifactIntegrityPolicy,
} from "./types.js";
import { hashReadable, preflightEntry } from "./hash.js";

export interface PendingIntegrityContradiction {
  readonly logicalPath: string;
  readonly declaredSha256: string;
  readonly observedSha256: string;
  readonly entryKind: "file" | "slice";
  readonly unpacked: boolean;
}

const UNAVAILABLE_UNPACKED_LIMITATION =
  "ASAR unpacked companion bytes were unavailable; no content hash or child artifact was produced.";

const emptyScan = (): {
  readonly nodes: Map<string, ArtifactNode>;
  readonly occurrences: MutableOccurrence[];
  readonly pendingContradictions: PendingIntegrityContradiction[];
} => ({ nodes: new Map(), occurrences: [], pendingContradictions: [] });

interface ScanContext {
  readonly reader: ArtifactReader;
  readonly limits: ArtifactLimits;
  readonly signal: AbortSignal | undefined;
  readonly integrity: ArtifactIntegrityPolicy;
  readonly nodes: Map<string, ArtifactNode>;
  readonly occurrences: MutableOccurrence[];
  readonly pendingContradictions: PendingIntegrityContradiction[];
  readonly occurrenceByPath: Map<string, MutableOccurrence>;
  readonly registry: ArtifactPathRegistry;
  totalBytes: number;
}

export const scanReader = async (
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
  const context: ScanContext = {
    reader,
    limits,
    signal,
    integrity,
    nodes,
    occurrences,
    pendingContradictions,
    occurrenceByPath: new Map<string, MutableOccurrence>(),
    registry: new ArtifactPathRegistry(),
    totalBytes: 0,
  };
  await visitArtifactEntries(context, reader, "");
  return { nodes, occurrences, pendingContradictions };
};

const visitArtifactEntries = async (
  context: ScanContext,
  currentReader: ArtifactReader,
  prefix: string,
): Promise<void> => {
  for await (const entry of currentReader.entries(context.signal)) {
    if (context.occurrences.length >= context.limits.maxEntries)
      throw new ArtifactReaderFailure("limit", "Artifact entry limit exceeded");
    const logicalPath = normalizeArtifactPath(
      prefix.length === 0 ? entry.path : `${prefix}/${entry.path}`,
      context.limits,
    );
    const expandableAsar = isExpandableAsar(entry, logicalPath);
    context.registry.add(
      logicalPath,
      expandableAsar ? "directory" : entry.kind,
    );
    preflightEntry(entry, context.limits);
    const parent = nearestParent(logicalPath, context.occurrenceByPath);
    const occurrence = createOccurrence(
      entry,
      logicalPath,
      parent?.occurrence_id ?? null,
    );
    let digested:
      | { readonly node: ArtifactNode; readonly mismatched: boolean }
      | undefined;
    try {
      digested = await digestArtifactEntry(
        context,
        currentReader,
        entry,
        logicalPath,
      );
    } catch (cause: unknown) {
      if (!isUnavailableUnpackedEntry(cause, entry)) throw cause;
      occurrence.hash_status = "unavailable";
      occurrence.limitations.push(UNAVAILABLE_UNPACKED_LIMITATION);
    }
    if (digested !== undefined) {
      context.nodes.set(digested.node.artifact_id, digested.node);
      occurrence.artifact_id = digested.node.artifact_id;
      occurrence.hash_status = digested.mismatched ? "mismatched" : "verified";
      if (digested.mismatched)
        occurrence.limitations.push(
          "Declared integrity metadata contradicts observed bytes.",
        );
    }
    context.occurrences.push(occurrence);
    context.occurrenceByPath.set(logicalPath, occurrence);
    if (expandableAsar && digested?.mismatched !== true)
      await visitNestedAsar(context, entry.adapterKey, logicalPath);
  }
};

const digestArtifactEntry = async (
  context: ScanContext,
  currentReader: ArtifactReader,
  entry: ArtifactEntry,
  logicalPath: string,
): Promise<
  { readonly node: ArtifactNode; readonly mismatched: boolean } | undefined
> => {
  if ((entry.kind !== "file" && entry.kind !== "slice") || entry.encrypted)
    return undefined;
  const remainingBytes = context.limits.maxTotalBytes - context.totalBytes;
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
    await currentReader.open(entry, context.signal),
    Math.min(context.limits.maxEntryBytes, remainingBytes),
    context.signal,
  );
  context.totalBytes += digest.bytes;
  const mismatched =
    entry.declaredSha256 !== null && entry.declaredSha256 !== digest.sha256;
  if (mismatched && context.integrity.mode === "fail")
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
    if (context.pendingContradictions.length >= context.integrity.maxMismatches)
      throw new ArtifactReaderFailure(
        "limit",
        "Artifact integrity mismatch limit exceeded",
      );
    context.pendingContradictions.push({
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

const visitNestedAsar = async (
  context: ScanContext,
  adapterKey: string,
  logicalPath: string,
): Promise<void> => {
  const nested = new AsarArtifactReader(adapterKey);
  try {
    await visitArtifactEntries(context, nested, logicalPath);
  } finally {
    await nested.close();
  }
};

const isExpandableAsar = (entry: ArtifactEntry, logicalPath: string): boolean =>
  entry.kind === "file" &&
  logicalPath.toLowerCase().endsWith(".asar") &&
  entry.adapterKey.startsWith("/");

const isUnavailableUnpackedEntry = (
  cause: unknown,
  entry: ArtifactEntry,
): boolean =>
  entry.unpacked &&
  cause instanceof ArtifactReaderFailure &&
  cause.reason === "unavailable";
