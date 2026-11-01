import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAsarHeaderAdmission } from "../AsarHeader.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import type { DestinationCaseSensitivity } from "../ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  type ArtifactReaderTraversal,
} from "../ArtifactReader.js";
import { assertArtifactSelectedSource } from "../ArtifactSelectedSource.js";
import { SafeOutputTree } from "../SafeOutputTree.js";
import {
  DEFAULT_DRY_RUN_PLAN_ENTRY_LIMIT,
  MAX_DRY_RUN_PLAN_ENTRY_LIMIT,
  type ArtifactCommand,
  type ArtifactExtractionPlan,
  type ArtifactExtractionPlanEntry,
  type ArtifactExtractionResult,
  type ArtifactNode,
  type ArtifactOccurrence,
} from "../../domain/artifactGraph.js";
import type { ArtifactInventorySnapshot } from "../../domain/artifactInventorySnapshot.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import {
  regularFileState,
  sameRegularFileState,
  type RegularFileState,
} from "../../filesystem/RegularFile.js";
import type { ArtifactExtractionInput } from "./ArtifactExtraction.js";

export const MAX_DRY_RUN_PLAN_PAGE_BYTES = 512 * 1024;
export const MAX_DRY_RUN_DIAGNOSTIC_STRING_BYTES = 4096;
const MAX_DRY_RUN_BASE_LIMITATIONS_BYTES = 64 * 1024;
const MAX_PORTABLE_POSIX_PATH_BYTES = 1023;
const MAX_VALIDATED_DRY_RUN_CACHE_ENTRIES = 8;

export interface DryRunSelectedOccurrence {
  readonly occurrence: ArtifactOccurrence;
  readonly node: ArtifactNode;
}

export interface DryRunExtractedOccurrence {
  readonly artifact_id: string;
  readonly relative_path: string;
  readonly sha256: string;
  readonly bytes_written: number;
  readonly created: boolean;
}

export interface UnresolvedDryRunPlan {
  readonly byOccurrenceId: ReadonlyMap<string, string>;
  readonly limitations: readonly string[];
}

export interface BuiltDryRunPlanCatalog {
  readonly allEntries: readonly ArtifactExtractionPlanEntry[];
  readonly totals: ArtifactExtractionPlan["totals"];
  readonly maxEntryPathBytes: number;
  readonly perOccurrenceOverheadBytes?: ReadonlyMap<string, number>;
}

export interface SlicedDryRunPlan {
  readonly plan: ArtifactExtractionPlan;
  readonly oversizedEntryLimitation?: string;
}

export interface CachedDryRunSnapshot {
  readonly inventory: ArtifactInventorySnapshot;
  readonly selected: readonly DryRunSelectedOccurrence[];
  readonly extracted: readonly DryRunExtractedOccurrence[];
  readonly traversal: ArtifactReaderTraversal;
  readonly materializationProvenance: readonly ArtifactCommand[];
  readonly unresolvedPlan: UnresolvedDryRunPlan;
  readonly catalog: BuiltDryRunPlanCatalog;
}

interface CachedValidatedDryRunPlan {
  readonly sourceFileState: RegularFileState;
  readonly destinationParent: string;
  readonly outputRootLength: number;
  readonly outputRootByteLength: number;
  readonly caseSensitivity: DestinationCaseSensitivity;
  readonly snapshot: CachedDryRunSnapshot;
}

const validatedDryRunPlanCache = new Map<string, CachedValidatedDryRunPlan>();

const sliceCodePointPrefix = (value: string, maxCodeUnits: number): string => {
  if (value.length <= maxCodeUnits) return value;
  let end = maxCodeUnits;
  const lastCode = value.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  return value.slice(0, end);
};

export const summarizeDryRunDiagnosticPath = (
  path: string,
  maxChars = 120,
): string => {
  if (path.length <= maxChars) return path;
  const byteLength = Buffer.byteLength(path, "utf8");
  return `${sliceCodePointPrefix(path, maxChars)}... (${String(byteLength)} UTF-8 bytes)`;
};

export const truncateDryRunDiagnosticString = (
  value: string,
  maxBytes = MAX_DRY_RUN_DIAGNOSTIC_STRING_BYTES,
): string => {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= maxBytes) return value;
  const suffix = `... [truncated ${String(totalBytes)} UTF-8 bytes]`;
  const targetPrefixBytes = Math.max(
    0,
    maxBytes - Buffer.byteLength(suffix, "utf8"),
  );
  let low = 0;
  let high = Math.min(value.length, targetPrefixBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= targetPrefixBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${sliceCodePointPrefix(value, low)}${suffix}`;
};

export const limitDryRunPlanText = truncateDryRunDiagnosticString;

export const boundDryRunBaseLimitations = (
  limitations: readonly string[],
  maxTotalBytes = MAX_DRY_RUN_BASE_LIMITATIONS_BYTES,
): readonly string[] => {
  const baseLimitations: string[] = [];
  const perItemMaxBytes = Math.min(
    MAX_DRY_RUN_DIAGNOSTIC_STRING_BYTES,
    Math.max(256, maxTotalBytes - 128),
  );
  // Track serialized JSON array bytes: 2 bytes for outer brackets plus (serialized item bytes + 1 comma byte) per element.
  let usedBytes = 2;
  let omittedCount = 0;
  for (const raw of limitations) {
    const item = truncateDryRunDiagnosticString(raw, perItemMaxBytes);
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (baseLimitations.length > 0 && usedBytes + itemBytes > maxTotalBytes) {
      omittedCount += 1;
      continue;
    }
    baseLimitations.push(item);
    usedBytes += itemBytes;
  }
  return omittedCount > 0
    ? [
        ...baseLimitations,
        `Omitted ${String(omittedCount)} additional dry-run limitation(s) to stay within the page byte budget.`,
      ]
    : baseLimitations;
};

export const formatDryRunOversizedEntryLimitation = (
  offset: number,
  logicalPath: string,
  estimatedBytes: number,
  maxPageBytes = MAX_DRY_RUN_PLAN_PAGE_BYTES,
): string =>
  `Skipped dry-run plan entry at offset ${String(offset)} (${summarizeDryRunDiagnosticPath(logicalPath, 120)}) because its serialized page representation (${String(estimatedBytes)} bytes) exceeds the maximum dry-run page budget (${String(maxPageBytes)} bytes).`;

const estimateDryRunPlanEntryBytes = (
  entry: ArtifactExtractionPlanEntry,
  perOccurrenceOverheadBytes = 0,
): number => {
  const entryJsonBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
  const pathBytes = Buffer.byteLength(
    JSON.stringify(entry.logical_path),
    "utf8",
  );
  return (
    entryJsonBytes +
    (entry.status === "planned" ? pathBytes + 220 : 0) +
    perOccurrenceOverheadBytes +
    64
  );
};

export const sliceDryRunPlanCatalogWithDiagnostics = (
  catalog: BuiltDryRunPlanCatalog,
  pageOptions: { readonly offset: number; readonly limit: number } = {
    offset: 0,
    limit: DEFAULT_DRY_RUN_PLAN_ENTRY_LIMIT,
  },
  baseOverheadBytes = 2048,
): SlicedDryRunPlan => {
  const offset = Number.isFinite(pageOptions.offset)
    ? Math.max(0, Math.trunc(pageOptions.offset))
    : 0;
  const limit = Number.isFinite(pageOptions.limit)
    ? Math.min(
        MAX_DRY_RUN_PLAN_ENTRY_LIMIT,
        Math.max(1, Math.trunc(pageOptions.limit)),
      )
    : DEFAULT_DRY_RUN_PLAN_ENTRY_LIMIT;
  const sanitizedOverheadBytes = Number.isFinite(baseOverheadBytes)
    ? Math.max(0, Math.trunc(baseOverheadBytes))
    : 2048;
  const totalEntries = catalog.allEntries.length;
  const maxEnd = Math.min(totalEntries, offset + limit);
  const pagedEntries: ArtifactExtractionPlanEntry[] = [];
  let pageBytes = sanitizedOverheadBytes;
  for (let index = offset; index < maxEnd; index += 1) {
    const entry = catalog.allEntries[index]!;
    const perOccurrenceBytes =
      catalog.perOccurrenceOverheadBytes?.get(entry.occurrence_id) ?? 0;
    const entryBytes = estimateDryRunPlanEntryBytes(entry, perOccurrenceBytes);
    if (pageBytes + entryBytes > MAX_DRY_RUN_PLAN_PAGE_BYTES) {
      if (pagedEntries.length === 0) {
        const nextOffset = index + 1 < totalEntries ? index + 1 : null;
        return {
          plan: {
            entries: [],
            page: {
              total_entries: totalEntries,
              offset,
              limit,
              returned_entries: 0,
              next_offset: nextOffset,
              truncated: true,
            },
            totals: catalog.totals,
          },
          oversizedEntryLimitation: formatDryRunOversizedEntryLimitation(
            index,
            entry.logical_path,
            pageBytes + entryBytes,
            MAX_DRY_RUN_PLAN_PAGE_BYTES,
          ),
        };
      }
      break;
    }
    pagedEntries.push(entry);
    pageBytes += entryBytes;
  }
  const nextOffset =
    offset + pagedEntries.length < totalEntries
      ? offset + pagedEntries.length
      : null;
  const truncated =
    nextOffset !== null || offset > 0 || pagedEntries.length < totalEntries;
  return {
    plan: {
      entries: pagedEntries,
      page: {
        total_entries: totalEntries,
        offset,
        limit,
        returned_entries: pagedEntries.length,
        next_offset: nextOffset,
        truncated,
      },
      totals: catalog.totals,
    },
  };
};

export const sliceDryRunPlanCatalog = (
  catalog: BuiltDryRunPlanCatalog,
  pageOptions: { readonly offset: number; readonly limit: number } = {
    offset: 0,
    limit: DEFAULT_DRY_RUN_PLAN_ENTRY_LIMIT,
  },
  baseOverheadBytes = 2048,
): ArtifactExtractionPlan =>
  sliceDryRunPlanCatalogWithDiagnostics(catalog, pageOptions, baseOverheadBytes)
    .plan;

const dryRunCacheSourceKey = (
  sourcePath: string,
  input: ArtifactExtractionInput,
): string =>
  JSON.stringify([
    sourcePath,
    absoluteCallerPath(input.selectedPath ?? input.inputPath),
    input.inputFormat,
    input.platform ?? process.platform,
    input.integrityPolicy,
    input.asarHeaderAdmission ?? resolveAsarHeaderAdmission(input.environment),
  ]);

export const cacheValidatedDryRunPlan = async ({
  sourcePath,
  input,
  resolvedOutputRoot,
  caseSensitivity,
  snapshot,
  signal,
}: {
  readonly sourcePath: string;
  readonly input: ArtifactExtractionInput;
  readonly resolvedOutputRoot: string;
  readonly caseSensitivity: DestinationCaseSensitivity;
  readonly snapshot: CachedDryRunSnapshot;
  readonly signal: AbortSignal | undefined;
}): Promise<void> => {
  if (snapshot.inventory.occurrences.some((item) => item.unpacked === true))
    return;
  abortIfNeeded(signal);
  const sourceStats = await lstat(sourcePath);
  abortIfNeeded(signal);
  if (!sourceStats.isFile()) return;
  const key = dryRunCacheSourceKey(sourcePath, input);
  validatedDryRunPlanCache.delete(key);
  if (validatedDryRunPlanCache.size >= MAX_VALIDATED_DRY_RUN_CACHE_ENTRIES) {
    const oldestKey = validatedDryRunPlanCache.keys().next().value;
    if (oldestKey !== undefined) validatedDryRunPlanCache.delete(oldestKey);
  }
  validatedDryRunPlanCache.set(key, {
    sourceFileState: regularFileState(sourceStats),
    destinationParent: dirname(resolvedOutputRoot),
    outputRootLength: resolvedOutputRoot.length,
    outputRootByteLength: Buffer.byteLength(resolvedOutputRoot, "utf8"),
    caseSensitivity,
    snapshot,
  });
};

export const tryReuseValidatedDryRunPlan = async ({
  input,
  sourcePath,
  signal,
  buildResult,
}: {
  readonly input: ArtifactExtractionInput;
  readonly sourcePath: string;
  readonly signal: AbortSignal | undefined;
  readonly buildResult: (
    snapshot: CachedDryRunSnapshot,
  ) => ArtifactExtractionResult;
}): Promise<ArtifactExtractionResult | undefined> => {
  const key = dryRunCacheSourceKey(sourcePath, input);
  const cached = validatedDryRunPlanCache.get(key);
  if (cached === undefined) return undefined;
  abortIfNeeded(signal);
  const currentStats = await lstat(sourcePath);
  abortIfNeeded(signal);
  if (
    !currentStats.isFile() ||
    !sameRegularFileState(cached.sourceFileState, currentStats) ||
    (input.expectedRootSha256 !== undefined &&
      input.expectedRootSha256 !==
        cached.snapshot.inventory.manifest.root_sha256)
  ) {
    validatedDryRunPlanCache.delete(key);
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact root changed after dry-run plan validation: ${sourcePath}`,
    );
  }
  const destination = await SafeOutputTree.checkDestination(input.outputRoot, {
    resourceScope: input.resourceScope,
  });
  abortIfNeeded(signal);
  const resolvedOutputRoot =
    destination.canonicalOutput ?? absoluteCallerPath(input.outputRoot);
  const outputByteLength = Buffer.byteLength(resolvedOutputRoot, "utf8");
  const nearPathLengthLimit =
    (input.platform ?? process.platform) === "win32" ||
    Math.max(outputByteLength, cached.outputRootByteLength) +
      cached.snapshot.catalog.maxEntryPathBytes +
      1 >
      MAX_PORTABLE_POSIX_PATH_BYTES;
  if (
    dirname(resolvedOutputRoot) !== cached.destinationParent ||
    destination.caseSensitivity !== cached.caseSensitivity ||
    (nearPathLengthLimit &&
      (resolvedOutputRoot.length !== cached.outputRootLength ||
        outputByteLength !== cached.outputRootByteLength))
  )
    return undefined;
  if (input.expectedRootSha256 !== undefined)
    await assertArtifactSelectedSource(sourcePath, input.selectedPath);
  return buildResult(cached.snapshot);
};
