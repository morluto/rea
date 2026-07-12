import { lstat, realpath } from "node:fs/promises";

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
import { SafeOutputTree } from "../artifacts/SafeOutputTree.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import { MachOSliceArtifactReader } from "../artifacts/MachOSliceArtifactReader.js";
import {
  artifactExtractionResultSchema,
  type ArtifactExtractionResult,
  type ArtifactGraphManifest,
  type ArtifactNode,
  type ArtifactOccurrence,
} from "../domain/artifactGraph.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { scanArtifactInventory } from "./ArtifactInventory.js";
import {
  digestCanonical,
  pageOf,
  toOutputLimits,
} from "./ArtifactGraphConstruction.js";

const PAGE_SIZE = 500;

/** Already-approved extraction request from a caller-owned policy boundary. */
export interface ArtifactExtractionInput {
  readonly inputPath: string;
  readonly inputFormat: BinaryTarget["format"];
  readonly outputRoot: string;
  readonly occurrenceIds: readonly string[];
  readonly offset: number;
  readonly limit: number;
  readonly limits: ArtifactLimits;
}

/** Extract selected inventory occurrences into an exclusively owned absent root. */
export const extractArtifact = async (
  input: ArtifactExtractionInput,
  signal?: AbortSignal,
): Promise<ArtifactExtractionResult> => {
  validateSelection(input.occurrenceIds);
  const sourcePath = await realpath(input.inputPath);
  const selectedIds = new Set(input.occurrenceIds);
  const inventory = await loadInventory(
    sourcePath,
    input.limits,
    selectedIds,
    signal,
  );
  const selected = input.occurrenceIds.map((id) => {
    const occurrence = inventory.occurrences.get(id);
    if (occurrence === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        `Selected artifact occurrence was not found: ${id}`,
      );
    if (
      (occurrence.entry_kind !== "file" && occurrence.entry_kind !== "slice") ||
      occurrence.artifact_id === null ||
      occurrence.encrypted ||
      occurrence.logical_path === "."
    )
      throw new ArtifactReaderFailure(
        "format",
        `Selected occurrence is not an extractable regular child file: ${id}`,
      );
    const node = inventory.nodes.get(occurrence.artifact_id);
    if (node === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        `Selected occurrence has no inventory node: ${id}`,
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
  const reader = await createReader(sourcePath, input.inputFormat);
  const output = await SafeOutputTree.create(input.outputRoot, input.limits);
  let readerClosed = false;
  const extracted: ExtractedOccurrence[] = [];
  try {
    const found = new Set<string>();
    const registry = new ArtifactPathRegistry();
    let entryCount = 0;
    for await (const entry of reader.entries(signal)) {
      entryCount += 1;
      if (entryCount > input.limits.maxEntries)
        throw new ArtifactReaderFailure(
          "limit",
          "Artifact entry limit exceeded during extraction",
        );
      const path = normalizeArtifactPath(entry.path, input.limits);
      registry.add(path, entry.kind);
      const selectedItem = byPath.get(path);
      if (selectedItem === undefined) continue;
      preflight(entry, input.limits);
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
      found.add(path);
    }
    if (found.size !== selected.length)
      throw new ArtifactReaderFailure(
        "integrity",
        "Selected inventory occurrence disappeared before extraction",
      );
    await reader.close();
    readerClosed = true;
    extracted.sort((left, right) =>
      left.relative_path.localeCompare(right.relative_path, "en"),
    );
    const result = createExtractionResult(
      input,
      inventory,
      selected,
      extracted,
    );
    await output.commit();
    return result;
  } catch (cause: unknown) {
    if (!readerClosed) await reader.close().catch(() => undefined);
    await output.rollback();
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
    schema_version: 1 as const,
    source_manifest_id: inventory.manifest.manifest_id,
    selected_occurrence_ids: selected
      .map(({ occurrence }) => occurrence.occurrence_id)
      .sort((left, right) => left.localeCompare(right)),
    files_sha256: digestCanonical(extracted),
    output_root_alias: "$OUTPUT_ROOT" as const,
  };
  return artifactExtractionResultSchema.parse({
    manifest: inventory.manifest,
    extraction_manifest: {
      ...extractionSemantic,
      extraction_id: `aex_${digestCanonical(extractionSemantic)}`,
    },
    output_root: "$OUTPUT_ROOT",
    artifacts: pageOf(extracted, input.offset, input.limit),
    containment_verified: true,
    cleanup: { attempted: false, verified: true, residual_paths: [] },
    limits: toOutputLimits(input.limits),
    provenance: [],
    limitations: [
      "Only caller-selected regular file occurrences were materialized.",
    ],
  });
};

interface LoadedInventory {
  readonly manifest: ArtifactGraphManifest;
  readonly occurrences: ReadonlyMap<string, ArtifactOccurrence>;
  readonly nodes: ReadonlyMap<string, ArtifactNode>;
}

const loadInventory = async (
  path: string,
  limits: ArtifactLimits,
  selectedIds: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<LoadedInventory> => {
  const snapshot = await scanArtifactInventory(path, limits, signal);
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
  return { manifest: snapshot.manifest, occurrences, nodes };
};

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

const createReader = async (
  path: string,
  format: BinaryTarget["format"],
): Promise<ArtifactReader> => {
  if ((await lstat(path)).isDirectory())
    return new DirectoryArtifactReader(path);
  if (format === "asar") return new AsarArtifactReader(path);
  if (format === "ipa" || format === "apk" || format === "zip")
    return new ZipArtifactReader(path, format);
  if (format === "mach-o") return new MachOSliceArtifactReader(path);
  throw new ArtifactReaderFailure(
    "unavailable",
    `Artifact format has no extraction reader: ${format}`,
  );
};

const validateSelection = (ids: readonly string[]): void => {
  if (ids.length === 0 || ids.length > PAGE_SIZE)
    throw new ArtifactReaderFailure(
      "limit",
      "Extraction requires 1 to 500 explicitly selected occurrences",
    );
  if (new Set(ids).size !== ids.length)
    throw new ArtifactReaderFailure(
      "path",
      "Extraction occurrence selection contains duplicates",
    );
};

const preflight = (entry: ArtifactEntry, limits: ArtifactLimits): void => {
  if ((entry.kind !== "file" && entry.kind !== "slice") || entry.encrypted)
    throw new ArtifactReaderFailure(
      "format",
      `Selected artifact entry cannot be read: ${entry.path}`,
    );
  if (entry.declaredSize !== null && entry.declaredSize > limits.maxEntryBytes)
    throw new ArtifactReaderFailure(
      "limit",
      `Selected artifact exceeds byte limit: ${entry.path}`,
    );
  if (
    entry.declaredSize !== null &&
    entry.compressedSize !== null &&
    (entry.compressedSize === 0
      ? entry.declaredSize > 0
      : entry.declaredSize / entry.compressedSize > limits.maxCompressionRatio)
  )
    throw new ArtifactReaderFailure(
      "limit",
      `Selected artifact exceeds compression ratio limit: ${entry.path}`,
    );
};
