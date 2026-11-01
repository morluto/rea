import { assertAdmittedRootDigest } from "../inventory/classify.js";
import {
  MAX_DRY_RUN_PLAN_PAGE_BYTES,
  boundDryRunBaseLimitations,
  cacheValidatedDryRunPlan,
  formatDryRunOversizedEntryLimitation,
  sliceDryRunPlanCatalog,
  sliceDryRunPlanCatalogWithDiagnostics,
  truncateDryRunDiagnosticString,
  tryReuseValidatedDryRunPlan,
  type BuiltDryRunPlanCatalog,
  type SlicedDryRunPlan,
} from "./DryRunPlanCache.js";
export { MAX_DRY_RUN_PLAN_PAGE_BYTES, formatDryRunOversizedEntryLimitation };
import { assertArtifactFileSelectedSource } from "../ArtifactFileSource.js";
import {
  assertArtifactSelectedSource,
  resolveArtifactSourcePath,
} from "../ArtifactSelectedSource.js";
import { InesArtifactReader } from "../InesArtifactReader.js";
import {
  openRootArtifact,
  hashStableRootArtifactHandle,
} from "../inventory/hashStableRootArtifact.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import type { AsarHeaderAdmission } from "../../config/asarHeaderAdmission.js";
import type { EspFlashSelection } from "../../domain/firmware/espFlashLocation.js";
import { artifactFormatDescriptor } from "../artifactFormats.js";
import { createArtifactReader } from "../createArtifactReader.js";
import { resolveAsarHeaderAdmission } from "../AsarHeader.js";
import {
  ArtifactEmbeddedFormatProbes,
  type ArtifactEmbeddedFormatProbeFacts,
} from "../ArtifactEmbeddedFormatProbes.js";
import { withArtifactRegularFile } from "../ArtifactFileOperation.js";
import { readArtifactFileChunks } from "../readArtifactFileChunks.js";
import {
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../../filesystem/RegularFile.js";
import type {
  ArtifactCleanupAttempt,
  ArtifactResourceOwner,
  ArtifactResourceScope,
} from "../ArtifactResourceScope.js";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { isPathWithinRoot } from "../../domain/localPath.js";
import { SafeOutputTreeDestinationRefusal } from "../SafeOutputTreeAdmission.js";

import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import {
  ArtifactPathRegistry,
  destinationCaseCollisions,
  normalizeArtifactPath,
  type DestinationCaseSensitivity,
} from "../ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactReaderTraversal,
} from "../ArtifactReader.js";
import { ArtifactTraversalObservation } from "../ArtifactTraversalObservation.js";
import { abortIfNeeded, hashReadable } from "../ArtifactHash.js";
import { streamChunkToBuffer } from "../StreamBytes.js";
import { SafeOutputTree, normalizeDestinationPath } from "../SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../SafeOutputTreeCreationFailure.js";
import { isZipPackageFormat } from "../../domain/zipPackageFormat.js";
import {
  DEFAULT_DRY_RUN_PLAN_ENTRY_LIMIT,
  MAX_DRY_RUN_PLAN_ENTRY_LIMIT,
  artifactExtractionResultSchema,
  type ArtifactExtractionPlan,
  type ArtifactExtractionPlanEntry,
  type ArtifactExtractionResult,
  type ArtifactGraphManifest,
  type ArtifactCommand,
  type ArtifactNode,
  type ArtifactOccurrence,
} from "../../domain/artifactGraph.js";
import { AnalysisUnsupportedTargetError } from "../../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { ArtifactInventorySnapshot } from "../../domain/artifactInventorySnapshot.js";
import { scanArtifactInventoryForExtractionInScope } from "../inventory/ArtifactInventory.js";
import type { TransferredArtifactInventorySource } from "../inventory/scanCanonical.js";
import type { ArtifactIntegrityPolicyName } from "../../domain/artifactIntegrityPolicy.js";

/** Local extraction input with the output root chosen by the adapter. */
export interface ArtifactExtractionInput {
  readonly asarHeaderAdmission?: AsarHeaderAdmission;
  /** Caller inputs when the target was explicitly selected as an ESP flash image. */
  readonly espFlashSelection?: EspFlashSelection | undefined;
  readonly inputPath: string;
  readonly expectedRootSha256?: string | undefined;
  /** Selected artifact spelling; packed I/O remains on inputPath. */
  readonly selectedPath?: string | undefined;
  readonly inputFormat: BinaryTarget["format"];
  readonly outputRoot: string;
  readonly dryRun?: boolean;
  readonly planOffset?: number;
  readonly planLimit?: number;
  readonly platform?: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly integrityPolicy: ArtifactIntegrityPolicyName;
  readonly resourceScope: ArtifactResourceScope;
}

/** Extract every regular inventory occurrence into an exclusively owned absent root. */
export const extractArtifact = async (
  input: ArtifactExtractionInput,
  signal?: AbortSignal,
): Promise<ArtifactExtractionResult> =>
  input.resourceScope.run(() => extractArtifactInScope(input, signal));

const extractArtifactInScope = async (
  input: ArtifactExtractionInput,
  signal?: AbortSignal,
): Promise<ArtifactExtractionResult> => {
  // Cancellation wins over every later refusal, including unsupported formats.
  abortIfNeeded(signal);
  const pageOptions = resolveDryRunPlanPageOptions(input);
  const sourcePath = await resolveArtifactSourcePath(input.inputPath);
  if (input.expectedRootSha256 !== undefined)
    await assertArtifactSelectedSource(sourcePath, input.selectedPath);
  if (input.dryRun === true && pageOptions.offset > 0) {
    const reused = await tryReuseValidatedDryRunPlan({
      input,
      sourcePath,
      signal,
      buildResult: (cached) =>
        createExtractionResult(
          input,
          cached.inventory,
          cached.selected,
          cached.extracted,
          cached.traversal,
          cached.materializationProvenance,
          cached.unresolvedPlan,
          cached.catalog,
        ),
    });
    if (reused !== undefined) return reused;
  }
  const probeFacts = await requireExtractableFormat(sourcePath, input, signal);
  const { snapshot, transferredSource } =
    await scanArtifactInventoryForExtractionInScope(
      input.inputPath,
      {
        resourceScope: input.resourceScope,
        selectedPath: input.selectedPath,
        expectedRootSha256: input.expectedRootSha256,
        signal,
        environment: input.environment,
        asarHeaderAdmission:
          input.asarHeaderAdmission ??
          resolveAsarHeaderAdmission(input.environment),
        espFlashSelection: input.espFlashSelection,
        integrity: input.integrityPolicy,
      },
      probeFacts,
    );
  const activeSource =
    transferredSource === undefined
      ? undefined
      : { ...transferredSource, releaseAttempted: false };
  try {
    return await materializeArtifactInventoryInScope(
      input,
      sourcePath,
      snapshot,
      signal,
      activeSource,
    );
  } catch (cause: unknown) {
    if (activeSource !== undefined && cause instanceof ArtifactReaderFailure)
      cause.retainPartialObservation({
        kind: "artifact-inventory",
        inventory: snapshot,
      });
    const attempt = await releaseTransferredArtifactSource(
      input.resourceScope,
      activeSource,
    );
    if (attempt?.kind === "failed")
      throw input.resourceScope.cleanupFailure(
        { kind: "failed", cause },
        [attempt],
        { kind: "artifact-inventory", inventory: snapshot },
      );
    throw cause;
  }
};

interface ActiveArtifactInventorySource extends TransferredArtifactInventorySource {
  releaseAttempted: boolean;
}

const releaseTransferredArtifactSource = async (
  resourceScope: ArtifactResourceScope,
  transferredSource: ActiveArtifactInventorySource | undefined,
): Promise<ArtifactCleanupAttempt | undefined> => {
  if (transferredSource === undefined || transferredSource.releaseAttempted)
    return undefined;
  transferredSource.releaseAttempted = true;
  return resourceScope.release(transferredSource.owner);
};

/** Materialize a scanned inventory, borrowing its admitted source when supplied. */
export const materializeArtifactInventoryInScope = async (
  input: ArtifactExtractionInput,
  sourcePath: string,
  snapshot: ArtifactInventorySnapshot,
  signal?: AbortSignal,
  transferredSource?: ActiveArtifactInventorySource,
): Promise<ArtifactExtractionResult> => {
  abortIfNeeded(signal);
  // A directory source must never acquire its own output as a new member on
  // the verification traversal. Resolve the selected parent before any write.
  if (transferredSource === undefined) {
    let canonicalSource: string;
    try {
      canonicalSource = await realpath(sourcePath);
    } catch (cause: unknown) {
      abortIfNeeded(signal);
      if (inventorySourceChanged(cause))
        throw new ArtifactReaderFailure(
          "integrity",
          `Inventoried source changed: ${sourcePath}`,
          { cause },
        );
      throw cause;
    }
    if ((await lstat(canonicalSource)).isDirectory()) {
      const { canonicalOutput } = await SafeOutputTree.resolveDestination(
        input.outputRoot,
      );
      const parent = dirname(canonicalOutput);
      if (isPathWithinRoot(canonicalSource, parent))
        throw new SafeOutputTreeDestinationRefusal(
          `Extraction output parent ${parent} is inside source directory ${canonicalSource}. Choose a temporary directory outside the source.`,
        );
    }
  }
  abortIfNeeded(signal);
  const containerMetadata = snapshot.occurrences.find(
    (row) => row.logical_path === ".",
  )?.format_metadata;
  if (
    containerMetadata?.kind === "godot-pck" &&
    containerMetadata.directory_status !== "available"
  )
    throw new AnalysisUnsupportedTargetError(
      "extract_artifact",
      input.selectedPath ?? input.inputPath,
      `Godot PCK directory is ${containerMetadata.directory_status}; its complete contents cannot be extracted`,
    );
  const isExposedByActiveReader = exposedByActiveReaderFilter(
    snapshot.occurrences,
  );
  if (
    containerMetadata?.kind === "unityfs" &&
    containerMetadata.directory_status !== "available"
  )
    throw new AnalysisUnsupportedTargetError(
      "extract_artifact",
      input.selectedPath ?? input.inputPath,
      `UnityFS directory is ${containerMetadata.directory_status}; its complete contents cannot be extracted`,
    );
  const selectedOccurrences = snapshot.occurrences.filter(
    (occurrence) =>
      (occurrence.entry_kind === "file" || occurrence.entry_kind === "slice") &&
      occurrence.logical_path !== ".",
  );
  const activeOccurrences = selectedOccurrences.filter(isExposedByActiveReader);
  const neededNodes = new Set(
    activeOccurrences.map(({ artifact_id: id }) => id),
  );
  const nodes = new Map<string, ArtifactNode>();
  for (const node of snapshot.nodes)
    if (neededNodes.has(node.artifact_id)) nodes.set(node.artifact_id, node);
  const selected = activeOccurrences.map((occurrence) => {
    // REA never decrypts archive entries, so an encrypted entry makes the
    // complete extraction unsupported rather than the archive invalid.
    if (occurrence.encrypted)
      throw new AnalysisUnsupportedTargetError(
        "extract_artifact",
        input.selectedPath ?? input.inputPath,
        `Archive entry ${occurrence.logical_path} is encrypted; REA does not decrypt archive entries, so the archive cannot be extracted completely`,
      );
    // Inventory retains unavailable source occurrences, but extraction cannot
    // materialize bytes it never observed.
    if (
      occurrence.entry_kind === "file" &&
      occurrence.artifact_id === null &&
      occurrence.hash_status === "unavailable"
    )
      throw new ArtifactReaderFailure(
        "unavailable",
        `Inventoried source bytes are unavailable for ${occurrence.logical_path}`,
        undefined,
        occurrence.unpacked === true
          ? {
              logicalPath: occurrence.logical_path,
              declaredSha256: null,
              calculatedSha256: null,
              unpacked: true,
            }
          : undefined,
      );
    if (
      (occurrence.entry_kind !== "file" && occurrence.entry_kind !== "slice") ||
      occurrence.artifact_id === null ||
      occurrence.logical_path === "."
    )
      throw new ArtifactReaderFailure(
        "format",
        `Selected occurrence is not an extractable regular child file: ${occurrence.logical_path} (${occurrence.occurrence_id})`,
      );
    const node = nodes.get(occurrence.artifact_id);
    if (node === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        `Selected occurrence has no inventory node: ${occurrence.occurrence_id}`,
      );
    return { occurrence, node };
  });
  return materializeSelection({
    input,
    sourcePath,
    inventory: snapshot,
    selected,
    signal,
    transferredSource,
  });
};

const exposedByActiveReaderFilter = (
  occurrences: readonly ArtifactOccurrence[],
): ((occurrence: ArtifactOccurrence) => boolean) => {
  const regularPaths = new Set(
    occurrences
      .filter(
        (occurrence) =>
          (occurrence.entry_kind === "file" ||
            occurrence.entry_kind === "slice") &&
          occurrence.logical_path !== ".",
      )
      .map(({ logical_path }) => logical_path),
  );
  const directoryPaths = new Set(
    occurrences
      .filter(({ entry_kind }) => entry_kind === "directory")
      .map(({ logical_path }) => logical_path),
  );
  return ({ logical_path }) => {
    // Nested members remain represented by their containing regular file;
    // only entries exposed by the active reader are traversed.
    let path = logical_path;
    for (
      let slash = path.lastIndexOf("/");
      slash >= 0;
      slash = path.lastIndexOf("/")
    ) {
      path = path.slice(0, slash);
      if (regularPaths.has(path) && !directoryPaths.has(path)) return false;
    }
    return true;
  };
};

interface SelectedOccurrence {
  readonly occurrence: ArtifactOccurrence;
  readonly node: ArtifactNode;
}

interface ExtractedOccurrence {
  readonly artifact_id: string;
  readonly relative_path: string;
  readonly sha256: string;
  readonly bytes_written: number;
  readonly created: boolean;
}

const materializeSelection = async ({
  input,
  sourcePath,
  inventory,
  selected,
  signal,
  transferredSource,
}: {
  readonly input: ArtifactExtractionInput;
  readonly sourcePath: string;
  readonly inventory: ArtifactInventorySnapshot;
  readonly selected: readonly SelectedOccurrence[];
  readonly signal: AbortSignal | undefined;
  readonly transferredSource: ActiveArtifactInventorySource | undefined;
}): Promise<ArtifactExtractionResult> => {
  const byPath = new Map<string, SelectedOccurrence>();
  for (const item of selected) {
    const path = item.occurrence.logical_path;
    if (byPath.has(path))
      throw new ArtifactReaderFailure(
        "path",
        `Artifact extraction path collision: ${JSON.stringify(path)}. Multiple selected occurrences share this normalized logical path; they cannot be materialized at the same destination path, even when the archive is valid. Inventory retains each occurrence.`,
      );
    byPath.set(path, item);
  }
  if (transferredSource !== undefined && "kind" in transferredSource.admission)
    await assertArtifactFileSelectedSource(
      sourcePath,
      transferredSource.admission.source,
      "Artifact extraction",
    );
  const reader = await createReader(
    sourcePath,
    input,
    inventory.manifest,
    transferredSource,
    signal,
  );
  const readerOwner: ArtifactResourceOwner = {
    kind: "reader" as const,
    reader,
    resource: `artifact reader for ${sourcePath}`,
  };
  const dryRun = input.dryRun === true;
  let localReaderOwner: ArtifactResourceOwner | undefined = readerOwner;
  let output: SafeOutputTree | undefined;
  let completed: ArtifactExtractionResult | undefined;
  let pendingFailure: unknown;
  const extracted: ExtractedOccurrence[] = [];
  try {
    await reader.prepareContainer?.(inventory.manifest.root_sha256, signal);
    const platform = input.platform ?? process.platform;
    let destinationCaseSensitivity: DestinationCaseSensitivity =
      "case-sensitive";
    let resolvedOutputRoot = absoluteCallerPath(input.outputRoot);
    if (dryRun) {
      const destination = await SafeOutputTree.checkDestination(
        input.outputRoot,
        { resourceScope: input.resourceScope },
      );
      destinationCaseSensitivity = destination.caseSensitivity;
      resolvedOutputRoot = destination.canonicalOutput ?? resolvedOutputRoot;
    } else {
      try {
        output = await SafeOutputTree.create(input.outputRoot, platform);
      } catch (cause: unknown) {
        if (cause instanceof SafeOutputTreeCreationFailure) output = cause.tree;
        throw cause;
      }
    }
    const traversal = new ArtifactTraversalObservation();
    traversal.onCoverage({
      status: inventory.coverage.status,
      limitations: inventory.limitations,
    });
    let unresolvedPlan: UnresolvedDryRunPlan = {
      byOccurrenceId: new Map(),
      limitations: [],
    };
    if (dryRun) {
      const containerVerified = reader.prepareContainer !== undefined;
      unresolvedPlan = await planSelectedEntries({
        reader,
        inventory,
        outputRoot: resolvedOutputRoot,
        platform,
        caseSensitivity: destinationCaseSensitivity,
        verifyContent: !containerVerified,
        byPath,
        extracted,
        traversal,
        signal,
      });
      if (isZipPackageFormat(inventory.manifest.root_format)) {
        const admission = requireStableRegularFileDescriptor(
          sourcePath,
          transferredSource?.admission,
        );
        await revalidateTransferredZipSource(
          sourcePath,
          admission,
          inventory.manifest.root_sha256,
          signal,
        );
      }
    } else {
      await writeSelectedEntries({
        reader,
        output: output!,
        byPath,
        extracted,
        traversal,
        signal,
      });
    }
    localReaderOwner = undefined;
    const closeAttempt = await input.resourceScope.release(readerOwner);
    if (closeAttempt.kind === "failed")
      throw input.resourceScope.cleanupFailure(
        { kind: "completed" },
        [closeAttempt],
        { kind: "artifact-inventory", inventory },
      );
    const sourceClose = await releaseTransferredArtifactSource(
      input.resourceScope,
      transferredSource,
    );
    if (sourceClose?.kind === "failed")
      throw input.resourceScope.cleanupFailure(
        { kind: "completed" },
        [sourceClose],
        { kind: "artifact-inventory", inventory },
      );
    abortIfNeeded(signal);
    extracted.sort((left, right) =>
      compareUnicodeCodePoints(left.relative_path, right.relative_path),
    );
    const traversalSnapshot = traversal.snapshot();
    const readerProvenance = reader.provenance();
    let dryRunCatalog: BuiltDryRunPlanCatalog | undefined;
    if (dryRun) {
      dryRunCatalog = buildDryRunPlanCatalog(
        inventory,
        selected,
        unresolvedPlan.byOccurrenceId,
      );
      await cacheValidatedDryRunPlan({
        sourcePath,
        input,
        resolvedOutputRoot,
        caseSensitivity: destinationCaseSensitivity,
        snapshot: {
          inventory,
          selected,
          extracted,
          traversal: traversalSnapshot,
          materializationProvenance: readerProvenance,
          unresolvedPlan,
          catalog: dryRunCatalog,
        },
        signal,
      });
    }
    completed = createExtractionResult(
      input,
      inventory,
      selected,
      extracted,
      traversalSnapshot,
      readerProvenance,
      unresolvedPlan,
      dryRunCatalog,
    );
    if (input.expectedRootSha256 !== undefined)
      await assertArtifactSelectedSource(sourcePath, input.selectedPath);
    if (output !== undefined) await output.commit(signal);
    return completed;
  } catch (cause: unknown) {
    pendingFailure = cause;
    const cleanupFailures = await releaseExtractionOwners(
      input.resourceScope,
      localReaderOwner,
      output,
      input.outputRoot,
    );
    const [firstCleanup, ...remainingCleanup] = cleanupFailures;
    if (firstCleanup !== undefined) {
      throw input.resourceScope.cleanupFailure(
        { kind: "failed", cause },
        [firstCleanup, ...remainingCleanup],
        output?.published === true && completed !== undefined
          ? { kind: "artifact-extraction", extraction: completed }
          : undefined,
      );
    }
    if (output?.published === true && completed !== undefined) return completed;
    throw cause;
  } finally {
    // Cancellation must run after the last close for every source. A pure
    // check throw must not mask an error already propagating from the try or
    // discard an extraction receipt after output has been durably published.
    try {
      abortIfNeeded(signal);
    } catch (abortCause: unknown) {
      if (
        pendingFailure === undefined &&
        !(output?.published === true && completed !== undefined) &&
        abortCause instanceof ArtifactReaderFailure &&
        abortCause.reason === "cancelled"
      )
        throw abortCause;
    }
  }
};

export const DRY_RUN_VALIDATED_LIMITATION =
  "Dry-run extraction validated destination admission, path collisions, and reader entries without creating destination files or directories.";
export const DRY_RUN_UNRESOLVED_LIMITATION =
  "Dry-run extraction validated destination admission and reader entries and classified destination path collisions and length limits with unresolved entries without creating destination files or directories.";
export const DRY_RUN_NON_FILE_DRIFT_SUMMARY_LIMITATION =
  "Dry-run extraction validated destination admission, path collisions, and regular file reader entries without creating destination files or directories; live non-file reader entries were not fully reconciled with the inventory snapshot.";
export const DRY_RUN_BYTE_TOTALS_LIMITATION =
  "Dry-run byte totals are declared and observed content-byte estimates, not guaranteed disk usage.";
export const DRY_RUN_OVER_LIMIT_LIMITATION =
  "Destination filesystem component and path length limits (such as 255-byte NAME_MAX) cannot be verified without creating files; over-limit paths remain unresolved in the dry-run plan.";
export const DRY_RUN_UNKNOWN_CASE_LIMITATION =
  "Destination directory case sensitivity is unknown because the destination parent has no observable cased entry; case-colliding paths remain unresolved in the dry-run plan.";
export const DRY_RUN_NON_ASCII_CASE_LIMITATION =
  "Non-ASCII case-folding paths depend on the destination filesystem case table and cannot be verified without creating files; affected paths remain unresolved in the dry-run plan.";
export const DRY_RUN_NON_FILE_RECONCILIATION_LIMITATION =
  "Non-file inventory entries were not fully reconciled with the live reader; affected directory, symlink, and metadata facts remain unresolved.";

export const formatDryRunNonFileKindMismatchReason = (
  inventoriedKind: string,
  path: string,
  observedKind: string,
): string =>
  `Inventoried ${inventoriedKind} entry ${path} was observed as ${observedKind} by the live reader.`;

export const formatDryRunNonFileAddedLimitation = (
  observedKind: string,
  path: string,
): string =>
  `Newly observed ${observedKind} entry ${path} is not in the inventory snapshot.`;

export const formatExtractionIntegrityContradictionLimitation = (
  count: number,
  dryRun: boolean,
): string =>
  `${String(count)} ${dryRun ? "selected" : "extracted"} file(s) contradict declared integrity metadata; their bytes are observed-untrusted.`;

export const formatDryRunPlanPageLimitation = (
  returnedEntries: number,
  totalEntries: number,
  offset: number,
  nextOffset: number | null,
): string =>
  nextOffset !== null
    ? `Dry-run plan entries are paged (${String(returnedEntries)} of ${String(totalEntries)} entries returned at offset ${String(offset)}; pass plan_offset=${String(nextOffset)} or --plan-offset ${String(nextOffset)} to inspect remaining entries).`
    : `Dry-run plan entries are paged (${String(returnedEntries)} of ${String(totalEntries)} entries returned at offset ${String(offset)}).`;

export const isStableRegularFileDescriptor = (
  value: unknown,
): value is StableRegularFileDescriptor => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as {
    readonly handle?: { readonly read?: unknown; readonly stat?: unknown };
    readonly initial?: {
      readonly size?: unknown;
      readonly dev?: unknown;
      readonly ino?: unknown;
      readonly mode?: unknown;
      readonly mtimeMs?: unknown;
      readonly ctimeMs?: unknown;
    };
  };
  return (
    typeof candidate.handle?.read === "function" &&
    typeof candidate.handle?.stat === "function" &&
    typeof candidate.initial?.size === "number" &&
    typeof candidate.initial?.dev === "number" &&
    typeof candidate.initial?.ino === "number" &&
    typeof candidate.initial?.mode === "number" &&
    typeof candidate.initial?.mtimeMs === "number" &&
    typeof candidate.initial?.ctimeMs === "number"
  );
};

export const requireStableRegularFileDescriptor = (
  sourcePath: string,
  value: unknown,
): StableRegularFileDescriptor => {
  if (!isStableRegularFileDescriptor(value))
    throw new ArtifactReaderFailure(
      "integrity",
      `Transferred ZIP source is not a stable regular-file descriptor: ${sourcePath}`,
    );
  return value;
};

const revalidateTransferredZipSource = async (
  path: string,
  source: StableRegularFileDescriptor,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> => {
  const digest = await hashReadable(
    readArtifactFileChunks(source.handle, {
      start: 0,
      end: source.initial.size,
      signal,
    }),
    signal,
  );
  abortIfNeeded(signal);
  const current = await source.handle.stat();
  if (
    !sameRegularFileState(source.initial, current) ||
    digest.bytes !== source.initial.size ||
    digest.sha256 !== expectedSha256
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact root changed after inventory: ${path}`,
    );
};

interface UnresolvedDryRunPlan {
  readonly byOccurrenceId: ReadonlyMap<string, string>;
  readonly limitations: readonly string[];
}

const MAX_PORTABLE_NAME_BYTES = 255;
const MAX_PORTABLE_POSIX_PATH_BYTES = 1023;
const MAX_PORTABLE_WIN32_PATH_LENGTH = 259;
const MAX_COMPONENT_LIMIT_PROBES = 16;

interface DestinationComponentLimitProbeState {
  maxAcceptedBytes: number;
  minRejectedBytes: number;
  readonly byByteLength: Map<number, string | null>;
  terminalFailure: string | undefined;
  probesUsed: number;
}

const createComponentLimitProbeState =
  (): DestinationComponentLimitProbeState => ({
    maxAcceptedBytes: 0,
    minRejectedBytes: MAX_PORTABLE_NAME_BYTES + 1,
    byByteLength: new Map(),
    terminalFailure: undefined,
    probesUsed: 0,
  });

const probeDestinationComponentLimit = async (
  destinationParent: string,
  segment: string,
  byteLength: number,
  state: DestinationComponentLimitProbeState,
  signal?: AbortSignal,
): Promise<string | null> => {
  if (state.terminalFailure !== undefined) return state.terminalFailure;
  if (byteLength <= state.maxAcceptedBytes) return null;
  if (byteLength >= state.minRejectedBytes) return "ENAMETOOLONG";
  const cached = state.byByteLength.get(byteLength);
  if (cached !== undefined) return cached;
  if (state.probesUsed >= MAX_COMPONENT_LIMIT_PROBES)
    return "component-limit probe budget exhausted";
  abortIfNeeded(signal);
  state.probesUsed += 1;
  const probeFailure = await lstat(join(destinationParent, segment)).then(
    () => null,
    (cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return null;
      return cause instanceof Error &&
        "code" in cause &&
        typeof cause.code === "string"
        ? cause.code
        : cause instanceof Error
          ? cause.message
          : String(cause);
    },
  );
  if (probeFailure === null) {
    state.maxAcceptedBytes = Math.max(state.maxAcceptedBytes, byteLength);
  } else if (probeFailure === "ENAMETOOLONG") {
    state.minRejectedBytes = Math.min(state.minRejectedBytes, byteLength);
  } else {
    state.terminalFailure = probeFailure;
  }
  state.byByteLength.set(byteLength, probeFailure);
  return probeFailure;
};

const primeComponentLimitProbeState = async (
  destinationParent: string,
  staged: readonly { readonly destinationPath: string }[],
  state: DestinationComponentLimitProbeState,
  signal?: AbortSignal,
): Promise<void> => {
  const representativeByLength = new Map<number, string>();
  for (const { destinationPath } of staged) {
    for (const segment of destinationPath.split("/")) {
      const byteLength = Buffer.byteLength(segment, "utf8");
      if (
        byteLength <= 0 ||
        byteLength > MAX_PORTABLE_NAME_BYTES ||
        segment.length > MAX_PORTABLE_NAME_BYTES ||
        representativeByLength.has(byteLength)
      )
        continue;
      representativeByLength.set(byteLength, segment);
    }
  }
  const buckets = [...representativeByLength.entries()].sort(
    ([left], [right]) => left - right,
  );
  const longest = buckets.at(-1);
  if (longest === undefined) return;
  const [longestBytes, longestSegment] = longest;
  const longestResult = await probeDestinationComponentLimit(
    destinationParent,
    longestSegment,
    longestBytes,
    state,
    signal,
  );
  if (longestResult === null || state.terminalFailure !== undefined) return;
  let low = 0;
  let high = buckets.length - 2;
  while (low <= high && state.probesUsed < MAX_COMPONENT_LIMIT_PROBES) {
    const mid = (low + high) >> 1;
    const [midBytes, midSegment] = buckets[mid]!;
    const result = await probeDestinationComponentLimit(
      destinationParent,
      midSegment,
      midBytes,
      state,
      signal,
    );
    if (state.terminalFailure !== undefined) return;
    if (result === null) low = mid + 1;
    else high = mid - 1;
  }
};

const summarizeDryRunReasonPath = (path: string): string =>
  path.length > 300 ? `${path.slice(0, 120)}...` : path;

const overLimitDestinationReason = async (
  resolvedOutputRoot: string,
  destinationParent: string,
  destinationPath: string,
  platform: NodeJS.Platform,
  componentLimitState: DestinationComponentLimitProbeState,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const displayPath = summarizeDryRunReasonPath(destinationPath);
  const segments = destinationPath.split("/");
  for (const segment of segments) {
    const byteLength = Buffer.byteLength(segment, "utf8");
    if (
      byteLength > MAX_PORTABLE_NAME_BYTES ||
      segment.length > MAX_PORTABLE_NAME_BYTES
    )
      return `Destination filesystem component length limit (such as 255-byte NAME_MAX) is not observed without creating files; segment of ${String(byteLength)} UTF-8 bytes in ${displayPath} remains unresolved during dry-run.`;
    const probeFailure = await probeDestinationComponentLimit(
      destinationParent,
      segment,
      byteLength,
      componentLimitState,
      signal,
    );
    if (probeFailure !== null)
      return `Destination filesystem component length probe on ${destinationParent} rejected or could not verify segment of ${String(byteLength)} UTF-8 bytes in ${displayPath} (${probeFailure}); path remains unresolved during dry-run.`;
  }
  const fullDestination = join(resolvedOutputRoot, ...segments);
  if (
    platform === "win32" &&
    (fullDestination.length > MAX_PORTABLE_WIN32_PATH_LENGTH ||
      Buffer.byteLength(fullDestination, "utf8") >
        MAX_PORTABLE_WIN32_PATH_LENGTH)
  )
    return `Destination filesystem path length limit (such as 260-character Windows MAX_PATH) is not observed without creating files; destination path of ${String(fullDestination.length)} UTF-16 code units for ${displayPath} remains unresolved during dry-run.`;
  const fullBytes = Buffer.byteLength(fullDestination, "utf8");
  if (fullBytes > MAX_PORTABLE_POSIX_PATH_BYTES)
    return `Destination filesystem path length limit (such as 1024-byte Darwin/portable PATH_MAX) is not observed without creating files; destination path of ${String(fullBytes)} UTF-8 bytes for ${displayPath} remains unresolved during dry-run.`;
  return undefined;
};

const verifyPlannedEntry = async (
  path: string,
  source: Readable,
  expected: { readonly sha256: string; readonly bytes: number },
  signal?: AbortSignal,
): Promise<void> => {
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const raw of source) {
      abortIfNeeded(signal);
      const chunk = streamChunkToBuffer(raw);
      if (chunk.length > expected.bytes - bytes)
        throw new ArtifactReaderFailure(
          "integrity",
          `Extracted content exceeds the inventoried size: ${path}`,
        );
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (bytes !== expected.bytes)
      throw new ArtifactReaderFailure(
        "integrity",
        `Extracted content size disagrees with inventory: ${path}`,
      );
    const sha256 = hash.digest("hex");
    if (sha256 !== expected.sha256)
      throw new ArtifactReaderFailure(
        "integrity",
        `Extracted content disagrees with inventory: ${path}`,
      );
  } catch (cause: unknown) {
    try {
      source.destroy();
    } catch {
      // Preserve the verification failure as the caller-visible error.
    }
    throw cause;
  }
};

const planSelectedEntries = async ({
  reader,
  inventory,
  outputRoot,
  platform,
  caseSensitivity,
  verifyContent,
  byPath,
  extracted,
  traversal,
  signal,
}: {
  readonly reader: ArtifactReader;
  readonly inventory: ArtifactInventorySnapshot;
  readonly outputRoot: string;
  readonly platform: NodeJS.Platform;
  readonly caseSensitivity: DestinationCaseSensitivity;
  readonly verifyContent: boolean;
  readonly byPath: Map<string, SelectedOccurrence>;
  readonly extracted: ExtractedOccurrence[];
  readonly traversal: ArtifactTraversalObservation;
  readonly signal: AbortSignal | undefined;
}): Promise<UnresolvedDryRunPlan> => {
  const readerRegistry = new ArtifactPathRegistry();
  const outputRegistry = new ArtifactPathRegistry({
    caseInsensitive: caseSensitivity === "case-insensitive",
  });
  const staged: {
    readonly selectedItem: SelectedOccurrence;
    readonly destinationPath: string;
  }[] = [];
  const isExposedByActiveReader = exposedByActiveReaderFilter(
    inventory.occurrences,
  );
  const inventoriedNonFileByPath = new Map<string, ArtifactOccurrence[]>();
  for (const occurrence of inventory.occurrences) {
    if (
      occurrence.logical_path === "." ||
      (occurrence.entry_kind !== "directory" &&
        occurrence.entry_kind !== "symlink" &&
        occurrence.entry_kind !== "metadata") ||
      !isExposedByActiveReader(occurrence)
    )
      continue;
    const bucket = inventoriedNonFileByPath.get(occurrence.logical_path);
    if (bucket === undefined)
      inventoriedNonFileByPath.set(occurrence.logical_path, [occurrence]);
    else bucket.push(occurrence);
  }
  const matchedNonFileOccurrenceIds = new Set<string>();
  const unresolvedByOccurrenceId = new Map<string, string>();
  const nonFileMismatches: string[] = [];
  for await (const entry of reader.entries(signal, traversal)) {
    const path = normalizeArtifactPath(entry.path);
    readerRegistry.add(path, entry.kind);
    if (entry.kind !== "file" && entry.kind !== "slice") {
      const candidates = inventoriedNonFileByPath.get(path);
      const exactMatch = candidates?.find(
        (candidate) =>
          candidate.entry_kind === entry.kind &&
          !matchedNonFileOccurrenceIds.has(candidate.occurrence_id),
      );
      if (exactMatch !== undefined) {
        matchedNonFileOccurrenceIds.add(exactMatch.occurrence_id);
      } else if (candidates !== undefined && candidates.length > 0) {
        const unmatched =
          candidates.find(
            (candidate) =>
              !matchedNonFileOccurrenceIds.has(candidate.occurrence_id),
          ) ?? candidates[0]!;
        matchedNonFileOccurrenceIds.add(unmatched.occurrence_id);
        const reason = formatDryRunNonFileKindMismatchReason(
          unmatched.entry_kind,
          path,
          entry.kind,
        );
        unresolvedByOccurrenceId.set(unmatched.occurrence_id, reason);
        nonFileMismatches.push(reason);
      } else {
        nonFileMismatches.push(
          formatDryRunNonFileAddedLimitation(entry.kind, path),
        );
      }
      continue;
    }
    const selectedItem = byPath.get(path);
    if (selectedItem === undefined) {
      throw new ArtifactReaderFailure(
        "integrity",
        `Regular artifact entry is missing from inventory: ${path}`,
      );
    }
    preflight(entry);
    if (
      !Number.isSafeInteger(selectedItem.node.size) ||
      selectedItem.node.size < 0
    )
      throw new ArtifactReaderFailure(
        "format",
        `Invalid expected extraction size for ${path}`,
      );
    const destinationPath = normalizeDestinationPath(path, platform);
    outputRegistry.add(destinationPath, "file");
    if (
      verifyContent ||
      entry.unpacked ||
      selectedItem.occurrence.unpacked === true
    ) {
      const stream = await reader.open(entry, signal);
      await verifyPlannedEntry(
        path,
        stream,
        {
          sha256: selectedItem.node.sha256,
          bytes: selectedItem.node.size,
        },
        signal,
      );
    }
    staged.push({ selectedItem, destinationPath });
    byPath.delete(path);
  }
  if (byPath.size > 0)
    throw new ArtifactReaderFailure(
      "integrity",
      `Inventoried regular artifact entries were not materialized: ${[...byPath.keys()].sort(compareUnicodeCodePoints).join(", ")}`,
    );
  for (const occurrences of inventoriedNonFileByPath.values()) {
    for (const occurrence of occurrences) {
      if (!matchedNonFileOccurrenceIds.has(occurrence.occurrence_id)) {
        const reason = `Inventoried ${occurrence.entry_kind} entry ${occurrence.logical_path} was not observed by the live reader.`;
        unresolvedByOccurrenceId.set(occurrence.occurrence_id, reason);
        nonFileMismatches.push(reason);
      }
    }
  }
  const limitations: string[] = [];
  let hasCaseLimitation = false;
  let hasOverLimitLimitation = false;
  const unresolvedCollisions =
    caseSensitivity === "case-sensitive"
      ? undefined
      : destinationCaseCollisions(
          staged.map(({ destinationPath }) => destinationPath),
        );
  const destinationParent = dirname(outputRoot);
  const componentLimitState = createComponentLimitProbeState();
  await primeComponentLimitProbeState(
    destinationParent,
    staged,
    componentLimitState,
    signal,
  );
  for (const { selectedItem, destinationPath } of staged) {
    const overLimitReason = await overLimitDestinationReason(
      outputRoot,
      destinationParent,
      destinationPath,
      platform,
      componentLimitState,
      signal,
    );
    if (overLimitReason !== undefined) {
      unresolvedByOccurrenceId.set(
        selectedItem.occurrence.occurrence_id,
        overLimitReason,
      );
      hasOverLimitLimitation = true;
      continue;
    }
    const collision = unresolvedCollisions?.get(destinationPath)?.[0];
    if (collision !== undefined) {
      unresolvedByOccurrenceId.set(
        selectedItem.occurrence.occurrence_id,
        caseSensitivity === "unknown"
          ? `Destination directory case sensitivity is unknown without creating files; case-colliding path ${collision.prefix} vs ${collision.other} cannot be verified as distinct during dry-run.`
          : `Destination filesystem case table for non-ASCII path ${collision.prefix} vs ${collision.other} is not observed without creating files; collision status remains unresolved during dry-run.`,
      );
      hasCaseLimitation = true;
      continue;
    }
    extracted.push({
      artifact_id: selectedItem.node.artifact_id,
      relative_path: destinationPath,
      sha256: selectedItem.node.sha256,
      bytes_written: 0,
      created: false,
    });
  }
  if (hasOverLimitLimitation) limitations.push(DRY_RUN_OVER_LIMIT_LIMITATION);
  if (hasCaseLimitation)
    limitations.push(
      caseSensitivity === "unknown"
        ? DRY_RUN_UNKNOWN_CASE_LIMITATION
        : DRY_RUN_NON_ASCII_CASE_LIMITATION,
    );
  if (nonFileMismatches.length > 0) {
    limitations.push(
      ...nonFileMismatches,
      DRY_RUN_NON_FILE_RECONCILIATION_LIMITATION,
    );
  }
  return { byOccurrenceId: unresolvedByOccurrenceId, limitations };
};

const resolveDryRunPlanPageOptions = (
  input: Pick<ArtifactExtractionInput, "dryRun" | "planOffset" | "planLimit">,
): { readonly offset: number; readonly limit: number } => {
  if (
    input.dryRun !== true &&
    (input.planOffset !== undefined || input.planLimit !== undefined)
  )
    throw new ArtifactReaderFailure(
      "format",
      "Dry-run plan paging options require dry_run=true.",
    );
  const offset = input.planOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new ArtifactReaderFailure(
      "format",
      `Invalid dry-run plan_offset: ${String(input.planOffset)}`,
    );
  const limit = input.planLimit ?? DEFAULT_DRY_RUN_PLAN_ENTRY_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DRY_RUN_PLAN_ENTRY_LIMIT
  )
    throw new ArtifactReaderFailure(
      "format",
      `Invalid dry-run plan_limit: ${String(input.planLimit)}`,
    );
  return { offset, limit };
};

const buildDryRunPlanCatalog = (
  inventory: ArtifactInventorySnapshot,
  selected: readonly SelectedOccurrence[],
  unresolvedCaseReasons: ReadonlyMap<string, string>,
): BuiltDryRunPlanCatalog => {
  const selectedById = new Map(
    selected.map((item) => [item.occurrence.occurrence_id, item] as const),
  );
  const nodesById = new Map(
    inventory.nodes.map((node) => [node.artifact_id, node] as const),
  );
  const contradictionBytesByOccurrenceId = new Map<string, number>();
  for (const contradiction of inventory.integrity_contradictions) {
    if (!selectedById.has(contradiction.occurrence_id)) continue;
    const prev =
      contradictionBytesByOccurrenceId.get(contradiction.occurrence_id) ?? 0;
    contradictionBytesByOccurrenceId.set(
      contradiction.occurrence_id,
      prev + Buffer.byteLength(JSON.stringify(contradiction), "utf8") + 2,
    );
  }
  const perOccurrenceOverheadBytes = new Map<string, number>();
  const entries: ArtifactExtractionPlanEntry[] = [];
  let plannedFiles = 0;
  let unsupportedEntries = 0;
  let unresolvedEntries = 0;
  let observedBytesEstimate = 0;
  let declaredBytesEstimate: number | null = 0;
  let maxEntryPathBytes = 0;
  for (const occurrence of inventory.occurrences) {
    if (occurrence.logical_path === ".") continue;
    const pathBytes = Buffer.byteLength(occurrence.logical_path, "utf8");
    if (pathBytes > maxEntryPathBytes) maxEntryPathBytes = pathBytes;
    const selectedItem = selectedById.get(occurrence.occurrence_id);
    if (selectedItem !== undefined) {
      let overheadBytes =
        (contradictionBytesByOccurrenceId.get(occurrence.occurrence_id) ?? 0) +
        Buffer.byteLength(JSON.stringify(occurrence.occurrence_id), "utf8") +
        2;
      for (const limitation of occurrence.limitations) {
        overheadBytes +=
          Buffer.byteLength(
            JSON.stringify(`${occurrence.logical_path}: ${limitation}`),
            "utf8",
          ) + 2;
      }
      if (overheadBytes > 0) {
        perOccurrenceOverheadBytes.set(occurrence.occurrence_id, overheadBytes);
      }
      const unresolvedReason = unresolvedCaseReasons.get(
        occurrence.occurrence_id,
      );
      if (unresolvedReason !== undefined) {
        unresolvedEntries += 1;
        entries.push({
          occurrence_id: occurrence.occurrence_id,
          logical_path: occurrence.logical_path,
          entry_kind: occurrence.entry_kind,
          status: "unresolved",
          reason: truncateDryRunDiagnosticString(unresolvedReason),
          observed_bytes: selectedItem.node.size,
          declared_bytes: occurrence.declared_size,
        });
        continue;
      }
      plannedFiles += 1;
      observedBytesEstimate += selectedItem.node.size;
      if (occurrence.declared_size === null) declaredBytesEstimate = null;
      else if (declaredBytesEstimate !== null)
        declaredBytesEstimate += occurrence.declared_size;
      entries.push({
        occurrence_id: occurrence.occurrence_id,
        logical_path: occurrence.logical_path,
        entry_kind: occurrence.entry_kind,
        status: "planned",
        reason: null,
        observed_bytes: selectedItem.node.size,
        declared_bytes: occurrence.declared_size,
      });
      continue;
    }
    const unresolvedNonFileReason = unresolvedCaseReasons.get(
      occurrence.occurrence_id,
    );
    if (unresolvedNonFileReason !== undefined) {
      unresolvedEntries += 1;
      entries.push({
        occurrence_id: occurrence.occurrence_id,
        logical_path: occurrence.logical_path,
        entry_kind: occurrence.entry_kind,
        status: "unresolved",
        reason: truncateDryRunDiagnosticString(unresolvedNonFileReason),
        observed_bytes: null,
        declared_bytes: occurrence.declared_size,
      });
      continue;
    }
    if (occurrence.entry_kind === "symlink") {
      unresolvedEntries += 1;
      entries.push({
        occurrence_id: occurrence.occurrence_id,
        logical_path: occurrence.logical_path,
        entry_kind: occurrence.entry_kind,
        status: "unresolved",
        reason:
          "Symlink entries are not materialized during extraction; target remains unresolved.",
        observed_bytes: null,
        declared_bytes: occurrence.declared_size,
      });
      continue;
    }
    unsupportedEntries += 1;
    const reason =
      occurrence.entry_kind === "directory"
        ? "Directory entries are not materialized directly; parent directories are created only as needed for planned regular files."
        : occurrence.entry_kind === "metadata"
          ? "Logical metadata declarations do not claim a destination file path."
          : "Nested archive member remains inside its containing regular file and is not expanded during single-container extraction.";
    const observedNode =
      occurrence.entry_kind === "directory" ||
      occurrence.entry_kind === "metadata" ||
      occurrence.artifact_id === null
        ? undefined
        : nodesById.get(occurrence.artifact_id);
    entries.push({
      occurrence_id: occurrence.occurrence_id,
      logical_path: occurrence.logical_path,
      entry_kind: occurrence.entry_kind,
      status: "unsupported",
      reason,
      observed_bytes:
        typeof observedNode?.size === "number" ? observedNode.size : null,
      declared_bytes: occurrence.declared_size,
    });
  }
  entries.sort(
    (left, right) =>
      compareUnicodeCodePoints(left.logical_path, right.logical_path) ||
      compareUnicodeCodePoints(left.occurrence_id, right.occurrence_id),
  );
  return {
    allEntries: entries,
    maxEntryPathBytes,
    perOccurrenceOverheadBytes,
    totals: {
      planned_files: plannedFiles,
      unsupported_entries: unsupportedEntries,
      unresolved_entries: unresolvedEntries,
      observed_bytes_estimate: observedBytesEstimate,
      declared_bytes_estimate: declaredBytesEstimate,
      byte_totals_basis: "declared-and-observed-content-estimates",
      byte_totals_note:
        "Declared and observed byte totals are content-byte estimates from archive metadata and inventory hashing, not guaranteed filesystem or disk-block usage.",
    },
  };
};

const createDryRunPlan = (
  inventory: ArtifactInventorySnapshot,
  selected: readonly SelectedOccurrence[],
  unresolvedCaseReasons: ReadonlyMap<string, string>,
  pageOptions: { readonly offset: number; readonly limit: number } = {
    offset: 0,
    limit: DEFAULT_DRY_RUN_PLAN_ENTRY_LIMIT,
  },
  baseOverheadBytes = 2048,
): ArtifactExtractionPlan =>
  sliceDryRunPlanCatalog(
    buildDryRunPlanCatalog(inventory, selected, unresolvedCaseReasons),
    pageOptions,
    baseOverheadBytes,
  );

const writeSelectedEntries = async ({
  reader,
  output,
  byPath,
  extracted,
  traversal,
  signal,
}: {
  readonly reader: ArtifactReader;
  readonly output: SafeOutputTree;
  readonly byPath: Map<string, SelectedOccurrence>;
  readonly extracted: ExtractedOccurrence[];
  readonly traversal: ArtifactTraversalObservation;
  readonly signal: AbortSignal | undefined;
}): Promise<void> => {
  const registry = new ArtifactPathRegistry();
  for await (const entry of reader.entries(signal, traversal)) {
    const path = normalizeArtifactPath(entry.path);
    registry.add(path, entry.kind);
    // Logical declarations may share a query path with a real file. They do
    // not consume that file's selection or participate in materialization.
    if (entry.kind !== "file" && entry.kind !== "slice") continue;
    const selectedItem = byPath.get(path);
    if (selectedItem === undefined) {
      throw new ArtifactReaderFailure(
        "integrity",
        `Regular artifact entry is missing from inventory: ${path}`,
      );
    }
    preflight(entry);
    const stream = await reader.open(entry, signal);
    const written = await output.write(
      path,
      stream,
      {
        sha256: selectedItem.node.sha256,
        bytes: selectedItem.node.size,
      },
      signal,
    );
    extracted.push({
      artifact_id: selectedItem.node.artifact_id,
      relative_path: written.relativePath,
      sha256: written.sha256,
      bytes_written: written.bytesWritten,
      created: true,
    });
    byPath.delete(path);
  }
  if (byPath.size > 0)
    throw new ArtifactReaderFailure(
      "integrity",
      `Inventoried regular artifact entries were not materialized: ${[...byPath.keys()].sort(compareUnicodeCodePoints).join(", ")}`,
    );
};

const releaseExtractionOwners = async (
  resourceScope: ArtifactResourceScope,
  readerOwner: ArtifactResourceOwner | undefined,
  output: SafeOutputTree | undefined,
  outputRoot: string,
): Promise<Extract<ArtifactCleanupAttempt, { readonly kind: "failed" }>[]> => {
  const failures: Extract<
    ArtifactCleanupAttempt,
    { readonly kind: "failed" }
  >[] = [];
  if (readerOwner !== undefined) {
    const attempt = await resourceScope.release(readerOwner);
    if (attempt.kind === "failed") failures.push(attempt);
  }
  if (output !== undefined) {
    const owner: ArtifactResourceOwner = {
      kind: "output-tree",
      tree: output,
      resource: outputRoot,
    };
    const attempt = await resourceScope.release(owner);
    if (attempt.kind === "failed") failures.push(attempt);
  }
  return failures;
};

const createExtractionResult = (
  input: ArtifactExtractionInput,
  inventory: ArtifactInventorySnapshot,
  selected: readonly SelectedOccurrence[],
  extracted: readonly ExtractedOccurrence[],
  traversal: ArtifactReaderTraversal,
  materializationProvenance: readonly ArtifactCommand[],
  unresolvedPlan: UnresolvedDryRunPlan = {
    byOccurrenceId: new Map(),
    limitations: [],
  },
  prebuiltCatalog?: BuiltDryRunPlanCatalog,
): ArtifactExtractionResult => {
  const selectedIds = new Set(
    selected.map(({ occurrence }) => occurrence.occurrence_id),
  );
  // A root contradiction covers the container bytes every extracted file came from.
  const rootId = inventory.occurrences.find(
    (row) => row.logical_path === ".",
  )?.occurrence_id;
  const rootContradicted = inventory.integrity_contradictions.some(
    ({ occurrence_id: id }) => id === rootId,
  );
  const fullSelectedOccurrenceIds = selected
    .map(({ occurrence }) => occurrence.occurrence_id)
    .sort(compareUnicodeCodePoints);
  const integrityContradictions = inventory.integrity_contradictions.filter(
    ({ occurrence_id: id }) => selectedIds.has(id) || id === rootId,
  );
  const extractedContradictions =
    integrityContradictions.length - (rootContradicted ? 1 : 0);
  const extractionSemantic = {
    source_manifest_id: inventory.manifest.manifest_id,
    selected_occurrence_ids: fullSelectedOccurrenceIds,
    files_sha256: digestCanonicalValue(extracted, "Artifact"),
    output_root_alias: "$OUTPUT_ROOT" as const,
  };
  const dryRun = input.dryRun === true;
  const pageOptions = resolveDryRunPlanPageOptions(input);
  const boundedTraversalLimitations = dryRun
    ? boundDryRunBaseLimitations(traversal.limitations)
    : traversal.limitations;
  const boundedUnresolvedLimitations = dryRun
    ? boundDryRunBaseLimitations(unresolvedPlan.limitations)
    : unresolvedPlan.limitations;
  const dryRunSummaryLimitation =
    unresolvedPlan.byOccurrenceId.size === 0 &&
    unresolvedPlan.limitations.length === 0
      ? DRY_RUN_VALIDATED_LIMITATION
      : unresolvedPlan.byOccurrenceId.size > 0
        ? DRY_RUN_UNRESOLVED_LIMITATION
        : DRY_RUN_NON_FILE_DRIFT_SUMMARY_LIMITATION;
  const contradictionSummaryLimitation =
    extractedContradictions === 0
      ? undefined
      : formatExtractionIntegrityContradictionLimitation(
          extractedContradictions,
          dryRun,
        );
  const baseOverheadBytes = dryRun
    ? Buffer.byteLength(JSON.stringify(inventory.manifest), "utf8") +
      Buffer.byteLength(JSON.stringify(input.outputRoot), "utf8") +
      Buffer.byteLength(JSON.stringify(inventory.provenance), "utf8") +
      Buffer.byteLength(JSON.stringify(materializationProvenance), "utf8") +
      Buffer.byteLength(JSON.stringify(inventory.coverage), "utf8") +
      Buffer.byteLength(JSON.stringify(boundedTraversalLimitations), "utf8") +
      Buffer.byteLength(JSON.stringify(boundedUnresolvedLimitations), "utf8") +
      Buffer.byteLength(JSON.stringify(dryRunSummaryLimitation), "utf8") +
      Buffer.byteLength(
        JSON.stringify(DRY_RUN_BYTE_TOTALS_LIMITATION),
        "utf8",
      ) +
      (contradictionSummaryLimitation === undefined
        ? 0
        : Buffer.byteLength(
            JSON.stringify(contradictionSummaryLimitation),
            "utf8",
          )) +
      2048
    : 0;
  const slicedPlan: SlicedDryRunPlan | undefined = dryRun
    ? sliceDryRunPlanCatalogWithDiagnostics(
        prebuiltCatalog ??
          buildDryRunPlanCatalog(
            inventory,
            selected,
            unresolvedPlan.byOccurrenceId,
          ),
        pageOptions,
        baseOverheadBytes,
      )
    : undefined;
  const plan = slicedPlan?.plan;
  const oversizedEntryLimitation = slicedPlan?.oversizedEntryLimitation;
  const platform = input.platform ?? process.platform;
  const pagedEntryIds =
    plan !== undefined
      ? new Set(plan.entries.map((entry) => entry.occurrence_id))
      : undefined;
  const returnedSelectedOccurrenceIds =
    pagedEntryIds === undefined || plan === undefined
      ? fullSelectedOccurrenceIds
      : plan.entries
          .filter((entry) => selectedIds.has(entry.occurrence_id))
          .map((entry) => entry.occurrence_id)
          .sort(compareUnicodeCodePoints);
  const pagedPlannedPaths =
    plan !== undefined
      ? new Set(
          plan.entries
            .filter((entry) => entry.status === "planned")
            .map((entry) =>
              normalizeDestinationPath(entry.logical_path, platform),
            ),
        )
      : undefined;
  const returnedArtifacts =
    pagedPlannedPaths === undefined
      ? extracted
      : extracted.filter((item) => pagedPlannedPaths.has(item.relative_path));
  const selectedForLimitations =
    pagedEntryIds === undefined
      ? selected
      : selected.filter(({ occurrence }) =>
          pagedEntryIds.has(occurrence.occurrence_id),
        );
  const returnedIntegrityContradictions =
    pagedEntryIds === undefined
      ? integrityContradictions
      : integrityContradictions.filter(
          ({ occurrence_id: id }) => pagedEntryIds.has(id) || id === rootId,
        );
  return artifactExtractionResultSchema.parse({
    manifest: inventory.manifest,
    extraction_manifest: {
      ...extractionSemantic,
      selected_occurrence_ids: returnedSelectedOccurrenceIds,
      extraction_id: `aex_${digestCanonicalValue(extractionSemantic, "Artifact")}`,
    },
    output_root: input.outputRoot,
    ...(plan !== undefined
      ? {
          dry_run: true,
          plan,
        }
      : {}),
    artifacts: returnedArtifacts,
    containment_verified: true,
    cleanup: { attempted: false, verified: true, residual_paths: [] },
    provenance: [...inventory.provenance, ...materializationProvenance],
    coverage: {
      ...inventory.coverage,
      status: traversal.status,
    },
    integrity_contradictions: returnedIntegrityContradictions,
    limitations: [
      ...boundedTraversalLimitations,
      ...selectedForLimitations.flatMap(({ occurrence }) =>
        occurrence.limitations.map(
          (limitation) => `${occurrence.logical_path}: ${limitation}`,
        ),
      ),
      dryRun
        ? unresolvedPlan.byOccurrenceId.size === 0 &&
          unresolvedPlan.limitations.length === 0
          ? DRY_RUN_VALIDATED_LIMITATION
          : unresolvedPlan.byOccurrenceId.size > 0
            ? DRY_RUN_UNRESOLVED_LIMITATION
            : DRY_RUN_NON_FILE_DRIFT_SUMMARY_LIMITATION
        : traversal.status === "complete"
          ? "All regular files exposed by the active artifact reader were materialized."
          : "All inventoried regular files exposed by the active reader were materialized; source traversal coverage is unknown, so the output is not established as a complete source copy.",
      dryRun
        ? DRY_RUN_BYTE_TOTALS_LIMITATION
        : "Publication verifies the selected inventoried regular files; it does not establish complete content decoding.",
      ...boundedUnresolvedLimitations,
      ...(oversizedEntryLimitation !== undefined
        ? [oversizedEntryLimitation]
        : []),
      ...(plan?.page?.truncated === true
        ? [
            formatDryRunPlanPageLimitation(
              plan.page.returned_entries,
              plan.page.total_entries,
              plan.page.offset,
              plan.page.next_offset,
            ),
          ]
        : []),
      ...(contradictionSummaryLimitation === undefined
        ? []
        : [contradictionSummaryLimitation]),
      ...(rootContradicted
        ? [
            "The container contradicts its declared integrity metadata; every extracted file is observed-untrusted.",
          ]
        : []),
    ],
  });
};

/**
 * Refuse a format without an extraction reader before inventory work starts.
 * The target kind, not the host, is unsupported by extraction. The error keeps
 * the caller's spelling of the path; I/O uses the canonical path.
 */
const requireExtractableFormat = async (
  path: string,
  input: Pick<
    ArtifactExtractionInput,
    | "inputPath"
    | "selectedPath"
    | "inputFormat"
    | "resourceScope"
    | "expectedRootSha256"
  >,
  signal?: AbortSignal,
): Promise<ArtifactEmbeddedFormatProbeFacts | undefined> => {
  const format = input.inputFormat;
  const directory = (await lstat(path)).isDirectory();
  // A thin Mach-O has no child entries of its own: inventory lists only its
  // root unless it carries an embedded pack, so it takes the same pack probe
  // as ELF and PE while only the universal container has a slice reader.
  if (!directory && artifactFormatDescriptor(format)?.extractable !== true) {
    const detected = await withArtifactRegularFile(
      path,
      input.resourceScope,
      signal,
      async (source) => {
        const probes = new ArtifactEmbeddedFormatProbes(path, source, signal);
        const pack =
          (await probes.godotPck()) !== undefined ||
          ((format === "elf" || format === "pe" || format === "mach-o") &&
            ((await probes.nodeSea()) !== undefined ||
              (await probes.pyInstaller()) !== undefined ||
              (await probes.bunStandalone()).status === "present" ||
              (await probes.dotnetBundle()) !== undefined));
        if (pack && input.expectedRootSha256 !== undefined) {
          const digest = await hashStableRootArtifactHandle(
            path,
            source.handle,
            source.initial,
            signal,
          );
          assertAdmittedRootDigest(
            path,
            input.expectedRootSha256,
            digest.sha256,
          );
        }
        return { pack, probeFacts: probes.completedFacts() };
      },
    );
    if (!detected.pack)
      throw new AnalysisUnsupportedTargetError(
        "extract_artifact",
        input.selectedPath ?? input.inputPath,
        `Artifact format has no extraction reader: ${format}`,
      );
    return detected.probeFacts;
  }
  return undefined;
};

/** Reader selection belongs to inventory classification, not the adapter hint. */
const createReader = async (
  path: string,
  input: Pick<
    ArtifactExtractionInput,
    | "inputPath"
    | "selectedPath"
    | "environment"
    | "asarHeaderAdmission"
    | "resourceScope"
    | "espFlashSelection"
  >,
  manifest: ArtifactGraphManifest,
  transferredSource?: ActiveArtifactInventorySource,
  signal?: AbortSignal,
): Promise<ArtifactReader> => {
  const containerFormat = manifest.root_format;
  if (containerFormat === "ines" && transferredSource === undefined) {
    let source: Awaited<ReturnType<typeof openRootArtifact>>;
    try {
      source = await openRootArtifact(path, input.resourceScope, signal);
    } catch (cause: unknown) {
      abortIfNeeded(signal);
      if (
        inventorySourceChanged(cause) ||
        (cause instanceof ArtifactReaderFailure && cause.reason === "format")
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `Inventoried source changed: ${path}`,
          { cause },
        );
      throw cause;
    }
    try {
      const digest = await hashStableRootArtifactHandle(
        path,
        source.handle,
        source.initial,
        signal,
      );
      assertAdmittedRootDigest(path, manifest.root_sha256, digest.sha256);
      return new InesArtifactReader(path, source, source.owner);
    } catch (cause: unknown) {
      const attempt = await input.resourceScope.release({
        kind: "file-handle",
        handle: source.owner,
        resource: `iNES source ${path}`,
      });
      if (attempt.kind === "failed")
        throw input.resourceScope.cleanupFailure({ kind: "failed", cause }, [
          attempt,
        ]);
      throw cause;
    }
  }
  // DMG inventory may mount read-only, but extraction has no DMG authority.
  const reader =
    containerFormat === "dmg"
      ? undefined
      : createArtifactReader(path, containerFormat, {
          environment: input.environment,
          // Inventory already records inaccessible descendants as omissions.
          // Keep that traversal policy here; the selected-path check below
          // still refuses any inventoried file that cannot be materialized.
          unreadableDirectories: "omit",
          selectedPath: absoluteCallerPath(
            input.selectedPath ?? input.inputPath,
          ),
          admission: transferredSource?.admission,
          espFlashSelection: input.espFlashSelection,
          asarHeaderAdmission:
            containerFormat === "asar"
              ? (input.asarHeaderAdmission ??
                resolveAsarHeaderAdmission(input.environment))
              : undefined,
        });
  if (reader === undefined)
    throw new AnalysisUnsupportedTargetError(
      "extract_artifact",
      input.selectedPath ?? input.inputPath,
      `Artifact format has no extraction reader: ${containerFormat}`,
    );
  return reader;
};

const preflight = (entry: ArtifactEntry): void => {
  if ((entry.kind !== "file" && entry.kind !== "slice") || entry.encrypted)
    throw new ArtifactReaderFailure(
      "format",
      `Selected artifact entry cannot be read: ${entry.path}`,
    );
};

const inventorySourceChanged = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  ["ENOENT", "ENOTDIR", "EISDIR", "ENOTFILE", "ESTALE", "ELOOP"].includes(
    String(cause.code),
  );
