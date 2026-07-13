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
  scanArtifactInventory,
  type ArtifactInventorySnapshot,
} from "./ArtifactInventory.js";
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

/** Scan both inputs once under the same bounded traversal policy. */
export const scanVersions = async (
  input: CrossVersionInvestigationInput,
  signal?: AbortSignal,
): Promise<Result<VersionSnapshots, AnalysisError>> => {
  try {
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError("find_changed_behavior"));
    const limits = artifactLimits(input.options);
    const left = await scanArtifactInventory(input.left_path, limits, signal);
    const right = await scanArtifactInventory(input.right_path, limits, signal);
    return ok({ left, right });
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
  const left = inventoryPages(input.left_path, snapshots.left, input.options);
  const right = inventoryPages(
    input.right_path,
    snapshots.right,
    input.options,
  );
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
  options: InvestigationRunOptions,
): Evidence[] => {
  const count = Math.max(
    1,
    Math.ceil(snapshot.nodes.length / options.page_size),
    Math.ceil(snapshot.occurrences.length / options.page_size),
    Math.ceil(snapshot.edges.length / options.page_size),
  );
  return Array.from({ length: count }, (_, index) =>
    inventoryPage(path, snapshot, options, index * options.page_size),
  );
};

const inventoryPage = (
  path: string,
  snapshot: ArtifactInventorySnapshot,
  options: InvestigationRunOptions,
  offset: number,
): Evidence => {
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
