import type { ArtifactLimits } from "../artifacts/ArtifactReader.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import {
  AnalysisCancelledError,
  ArtifactOperationError,
  type AnalysisError,
} from "../domain/errors.js";
import type {
  CrossVersionInvestigationInput,
  InvestigationRunOptions,
  InvestigationRunTarget,
} from "../domain/investigationWorkspace.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  paginateArtifactInventory,
  type ArtifactIntegrityPolicy,
  type ArtifactInventorySnapshot,
} from "./ArtifactInventory.js";
import { scanAuthorizedArtifactInventory } from "./AuthorizedArtifactInventory.js";
import { ARTIFACT_GRAPH_PROVIDER } from "./InvestigationProviders.js";

export const AUTOMATIC_RUN_LIMITATION =
  "Automatic cross-version runs compare shipped artifact structure only; they do not execute either version.";

export interface VersionSnapshots {
  readonly left: ArtifactInventorySnapshot;
  readonly right: ArtifactInventorySnapshot;
}

export interface InventoryEvidencePages {
  readonly left: readonly Evidence[];
  readonly right: readonly Evidence[];
}

/** Injectable artifact scan boundary used by paired version inventory. */
export type VersionInventoryScanner = typeof scanAuthorizedArtifactInventory;

/** Inputs shared by the two scans in one version comparison. */
export interface VersionInventoryScanOptions {
  readonly leftPath: string;
  readonly rightPath: string;
  readonly inputRoots: readonly string[];
  readonly limits: ArtifactLimits;
  readonly signal?: AbortSignal;
  readonly integrity: ArtifactIntegrityPolicy;
}

/** Start both independent version scans while preserving left/right identity. */
export const scanVersionInventories = async (
  options: VersionInventoryScanOptions,
  scanner: VersionInventoryScanner = scanAuthorizedArtifactInventory,
): Promise<VersionSnapshots> => {
  const [left, right] = await Promise.all([
    scanner({
      inputPath: options.leftPath,
      roots: options.inputRoots,
      limits: options.limits,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      integrity: options.integrity,
    }),
    scanner({
      inputPath: options.rightPath,
      roots: options.inputRoots,
      limits: options.limits,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      integrity: options.integrity,
    }),
  ]);
  return { left, right };
};

/** Authorize and scan both inputs once under the same bounded traversal policy. */
export const scanVersions = async (
  input: CrossVersionInvestigationInput,
  inputRoots: readonly string[],
  signal?: AbortSignal,
  integrityContinueEnabled = false,
): Promise<Result<VersionSnapshots, AnalysisError>> => {
  try {
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError("find_changed_behavior"));
    const limits = artifactLimits(input.options);
    const integrity: ArtifactIntegrityPolicy = {
      mode: input.integrity_policy,
      approved: input.integrity_continue_approved,
      enabled: integrityContinueEnabled,
      maxMismatches: input.max_integrity_mismatches,
    };
    return ok(
      await scanVersionInventories({
        leftPath: input.left_path,
        rightPath: input.right_path,
        inputRoots,
        limits,
        ...(signal === undefined ? {} : { signal }),
        integrity,
      }),
    );
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure)
      return err(
        new ArtifactOperationError(
          "inventory_artifact",
          cause.reason,
          cause.details,
        ),
      );
    return err(new ArtifactOperationError("inventory_artifact", "io"));
  }
};

/** Project complete snapshots into bounded, comparable Evidence page sets. */
export const createInventoryEvidencePages = (
  input: CrossVersionInvestigationInput,
  snapshots: VersionSnapshots,
): Result<InventoryEvidencePages, AnalysisError> => {
  const left = inventoryPages(input.left_path, snapshots.left, input);
  const right = inventoryPages(input.right_path, snapshots.right, input);
  if (left.length > 100 || right.length > 100)
    return err(new ArtifactOperationError("inventory_artifact", "limit"));
  return ok({ left, right });
};

/** Reduce a snapshot to the content commitments used by run identity. */
export const targetFor = (
  snapshot: ArtifactInventorySnapshot,
): InvestigationRunTarget => ({
  root_sha256: snapshot.manifest.root_sha256,
  graph_sha256: snapshot.manifest.graph_sha256,
  manifest_id: snapshot.manifest.manifest_id,
  format: snapshot.manifest.root_format,
});

/** Preserve scan and execution limitations in stable order. */
export const runLimitations = (snapshots: VersionSnapshots): string[] =>
  [
    ...new Set([
      ...snapshots.left.limitations.map((item) => `Left: ${item}`),
      ...snapshots.right.limitations.map((item) => `Right: ${item}`),
      AUTOMATIC_RUN_LIMITATION,
    ]),
  ].sort((left, right) => left.localeCompare(right));

const inventoryPages = (
  path: string,
  snapshot: ArtifactInventorySnapshot,
  input: CrossVersionInvestigationInput,
): Evidence[] => {
  const options = input.options;
  const count = Math.max(
    1,
    Math.ceil(snapshot.nodes.length / options.page_size),
    Math.ceil(snapshot.occurrences.length / options.page_size),
    Math.ceil(snapshot.edges.length / options.page_size),
  );
  return Array.from({ length: count }, (_, index) =>
    inventoryPage(path, snapshot, input, index * options.page_size),
  );
};

const inventoryPage = (
  path: string,
  snapshot: ArtifactInventorySnapshot,
  input: CrossVersionInvestigationInput,
  offset: number,
): Evidence => {
  const options = input.options;
  const result = paginateArtifactInventory(snapshot, {
    nodeOffset: offset,
    nodeLimit: options.page_size,
    occurrenceOffset: offset,
    occurrenceLimit: options.page_size,
    edgeOffset: offset,
    edgeLimit: options.page_size,
  });
  return createEvidence(
    {
      path,
      sha256: snapshot.manifest.root_sha256,
      format: snapshot.manifest.root_format,
    },
    ARTIFACT_GRAPH_PROVIDER,
    {
      operation: "inventory_artifact",
      parameters: {
        node_offset: offset,
        node_limit: options.page_size,
        occurrence_offset: offset,
        occurrence_limit: options.page_size,
        edge_offset: offset,
        edge_limit: options.page_size,
        max_entries: options.max_entries,
        max_total_bytes: options.max_total_bytes,
        max_entry_bytes: options.max_entry_bytes,
        max_compression_ratio: options.max_compression_ratio,
        max_depth: options.max_depth,
        max_path_bytes: options.max_path_bytes,
        integrity_policy: input.integrity_policy,
        integrity_continue_approved: input.integrity_continue_approved,
        max_integrity_mismatches: input.max_integrity_mismatches,
      },
      result: jsonValueSchema.parse(result),
      rawResult: null,
      limitations: result.limitations,
      locations: result.occurrences.items.map(
        ({ logical_path: logicalPath }) => ({
          kind: "artifact-path" as const,
          path: logicalPath,
        }),
      ),
    },
  );
};

const artifactLimits = (options: InvestigationRunOptions): ArtifactLimits => ({
  maxEntries: options.max_entries,
  maxTotalBytes: options.max_total_bytes,
  maxEntryBytes: options.max_entry_bytes,
  maxCompressionRatio: options.max_compression_ratio,
  maxDepth: options.max_depth,
  maxPathBytes: options.max_path_bytes,
});
