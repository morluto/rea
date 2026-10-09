import { lstat, realpath } from "node:fs/promises";

import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import { AsarArtifactReader } from "../AsarArtifactReader.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "../ArtifactReader.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { SafeOutputTree } from "../SafeOutputTree.js";
import { ZipArtifactReader } from "../ZipArtifactReader.js";
import { MachOSliceArtifactReader } from "../MachOSliceArtifactReader.js";
import {
  artifactExtractionResultSchema,
  type ArtifactExtractionResult,
  type ArtifactGraphManifest,
  type ArtifactNode,
  type ArtifactOccurrence,
} from "../../domain/artifactGraph.js";
import { AnalysisUnsupportedTargetError } from "../../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { scanArtifactInventory } from "../inventory/ArtifactInventory.js";

/** Local extraction input with the output root chosen by the adapter. */
export interface ArtifactExtractionInput {
  readonly inputPath: string;
  readonly inputFormat: BinaryTarget["format"];
  readonly outputRoot: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

/** Extract every regular inventory occurrence into an exclusively owned absent root. */
export const extractArtifact = async (
  input: ArtifactExtractionInput,
  signal?: AbortSignal,
): Promise<ArtifactExtractionResult> => {
  // Cancellation wins over every later refusal, including unsupported formats.
  abortIfNeeded(signal);
  const sourcePath = await realpath(input.inputPath);
  await requireExtractableFormat(sourcePath, input);
  const snapshot = await scanArtifactInventory(sourcePath, {
    signal,
    environment: input.environment,
  });
  const selectedOccurrences = snapshot.occurrences.filter(
    (occurrence) =>
      (occurrence.entry_kind === "file" || occurrence.entry_kind === "slice") &&
      occurrence.logical_path !== ".",
  );
  const selectedIds = new Set(
    selectedOccurrences.map(({ occurrence_id: id }) => id),
  );
  const occurrences = new Map<string, ArtifactOccurrence>();
  const neededNodes = new Set<string>();
  collectOccurrences(
    snapshot.occurrences,
    selectedIds,
    occurrences,
    neededNodes,
  );
  const nodes = new Map<string, ArtifactNode>();
  collectNodes(snapshot.nodes, neededNodes, nodes);
  const inventory: LoadedInventory = {
    manifest: snapshot.manifest,
    occurrences,
    nodes,
  };
  const selected = selectedOccurrences.map((occurrence) => {
    // REA never decrypts archive entries, so an encrypted entry makes the
    // complete extraction unsupported rather than the archive invalid.
    if (occurrence.encrypted)
      throw new AnalysisUnsupportedTargetError(
        "extract_artifact",
        input.inputPath,
        `Archive entry ${occurrence.logical_path} is encrypted; REA does not decrypt archive entries, so the archive cannot be extracted completely`,
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
    const node = inventory.nodes.get(occurrence.artifact_id);
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
    inventory,
    selected,
    signal,
  });
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
  readonly created: true;
}

const materializeSelection = async ({
  input,
  sourcePath,
  inventory,
  selected,
  signal,
}: {
  readonly input: ArtifactExtractionInput;
  readonly sourcePath: string;
  readonly inventory: LoadedInventory;
  readonly selected: readonly SelectedOccurrence[];
  readonly signal: AbortSignal | undefined;
}): Promise<ArtifactExtractionResult> => {
  const byPath = new Map(
    selected.map((item) => [item.occurrence.logical_path, item]),
  );
  const reader = await createReader(sourcePath, input);
  let output: SafeOutputTree | undefined;
  let readerCloseAttempted = false;
  let readerClosed = false;
  const extracted: ExtractedOccurrence[] = [];
  try {
    output = await SafeOutputTree.create(input.outputRoot);
    const materialized: SelectedOccurrence[] = [];
    const registry = new ArtifactPathRegistry();
    for await (const entry of reader.entries(signal)) {
      const path = normalizeArtifactPath(entry.path);
      registry.add(path, entry.kind);
      const selectedItem = byPath.get(path);
      if (selectedItem === undefined) {
        if (entry.kind === "file" || entry.kind === "slice")
          throw new ArtifactReaderFailure(
            "integrity",
            `Regular artifact entry is missing from inventory: ${path}`,
          );
        continue;
      }
      preflight(entry);
      const stream = await reader.open(entry, signal);
      const written = await output.write(
        path,
        stream,
        selectedItem.node.sha256,
        signal,
      );
      extracted.push({
        artifact_id: selectedItem.node.artifact_id,
        relative_path: written.relativePath,
        sha256: written.sha256,
        bytes_written: written.bytesWritten,
        created: true,
      });
      materialized.push(selectedItem);
    }
    readerCloseAttempted = true;
    await reader.close();
    readerClosed = true;
    extracted.sort((left, right) =>
      compareUnicodeCodePoints(left.relative_path, right.relative_path),
    );
    const result = createExtractionResult(
      input,
      inventory,
      materialized,
      extracted,
    );
    await output.commit();
    return result;
  } catch (cause: unknown) {
    const cleanupFailures: {
      readonly cause: unknown;
      readonly resource: string;
    }[] = [];
    if (readerCloseAttempted && !readerClosed)
      cleanupFailures.push({
        cause,
        resource: `artifact reader for ${sourcePath}`,
      });
    if (!readerCloseAttempted) {
      try {
        readerCloseAttempted = true;
        await reader.close();
      } catch (cleanupCause: unknown) {
        cleanupFailures.push({
          cause: cleanupCause,
          resource: `artifact reader for ${sourcePath}`,
        });
      }
    }
    if (output !== undefined) {
      try {
        await output.rollback();
      } catch (cleanupCause: unknown) {
        cleanupFailures.push({
          cause: cleanupCause,
          resource: input.outputRoot,
        });
      }
    }
    if (cleanupFailures.length > 0) {
      const observations = cleanupFailures.map(
        ({ cause: cleanupCause, resource }) =>
          ArtifactReaderFailure.cleanupObservation(cleanupCause, resource),
      );
      throw ArtifactReaderFailure.withCleanup(cause, {
        reason: observations.map(({ reason }) => reason).join("; "),
        resources: [
          ...new Set(observations.flatMap(({ resources }) => resources)),
        ],
      });
    }
    throw cause;
  }
};

const createExtractionResult = (
  input: ArtifactExtractionInput,
  inventory: LoadedInventory,
  selected: readonly SelectedOccurrence[],
  extracted: readonly ExtractedOccurrence[],
): ArtifactExtractionResult => {
  const extractionSemantic = {
    source_manifest_id: inventory.manifest.manifest_id,
    selected_occurrence_ids: selected
      .map(({ occurrence }) => occurrence.occurrence_id)
      .sort(compareUnicodeCodePoints),
    files_sha256: digestCanonicalValue(extracted, "Artifact"),
    output_root_alias: "$OUTPUT_ROOT" as const,
  };
  return artifactExtractionResultSchema.parse({
    manifest: inventory.manifest,
    extraction_manifest: {
      ...extractionSemantic,
      extraction_id: `aex_${digestCanonicalValue(extractionSemantic, "Artifact")}`,
    },
    output_root: input.outputRoot,
    artifacts: extracted,
    containment_verified: true,
    cleanup: { attempted: false, verified: true, residual_paths: [] },
    provenance: [],
    limitations: [
      "All regular files in the active artifact were materialized; nested archive contents remain represented by their containing file.",
    ],
  });
};

interface LoadedInventory {
  readonly manifest: ArtifactGraphManifest;
  readonly occurrences: ReadonlyMap<string, ArtifactOccurrence>;
  readonly nodes: ReadonlyMap<string, ArtifactNode>;
}

const collectOccurrences = (
  items: readonly ArtifactOccurrence[],
  selected: ReadonlySet<string>,
  output: Map<string, ArtifactOccurrence>,
  neededNodes: Set<string>,
): void => {
  for (const item of items) {
    if (!selected.has(item.occurrence_id)) continue;
    output.set(item.occurrence_id, item);
    if (item.artifact_id !== null) neededNodes.add(item.artifact_id);
  }
};

const collectNodes = (
  items: readonly ArtifactNode[],
  selected: ReadonlySet<string>,
  output: Map<string, ArtifactNode>,
): void => {
  for (const item of items)
    if (selected.has(item.artifact_id)) output.set(item.artifact_id, item);
};

const ZIP_FORMATS = ["ipa", "apk", "msix", "appx", "zip"] as const;

const isZipFormat = (
  format: BinaryTarget["format"],
): format is (typeof ZIP_FORMATS)[number] =>
  (ZIP_FORMATS as readonly string[]).includes(format);

/**
 * Refuse a format without an extraction reader before inventory work starts.
 * The target kind, not the host, is unsupported by extraction. The error keeps
 * the caller's spelling of the path; I/O uses the canonical path.
 */
const requireExtractableFormat = async (
  path: string,
  input: Pick<ArtifactExtractionInput, "inputPath" | "inputFormat">,
): Promise<boolean> => {
  const format = input.inputFormat;
  const directory = (await lstat(path)).isDirectory();
  if (
    !directory &&
    format !== "asar" &&
    format !== "mach-o" &&
    !isZipFormat(format)
  )
    throw new AnalysisUnsupportedTargetError(
      "extract_artifact",
      input.inputPath,
      `Artifact format has no extraction reader: ${format}`,
    );
  return directory;
};

const createReader = async (
  path: string,
  input: Pick<
    ArtifactExtractionInput,
    "inputPath" | "inputFormat" | "environment"
  >,
): Promise<ArtifactReader> => {
  const format = input.inputFormat;
  if (await requireExtractableFormat(path, input))
    return new DirectoryArtifactReader(path);
  if (format === "asar") return new AsarArtifactReader(path);
  if (isZipFormat(format)) return new ZipArtifactReader(path, format);
  return new MachOSliceArtifactReader(path, input.environment);
};

const preflight = (entry: ArtifactEntry): void => {
  if ((entry.kind !== "file" && entry.kind !== "slice") || entry.encrypted)
    throw new ArtifactReaderFailure(
      "format",
      `Selected artifact entry cannot be read: ${entry.path}`,
    );
};
