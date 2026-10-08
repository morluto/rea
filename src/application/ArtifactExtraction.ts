import { lstat, realpath } from "node:fs/promises";

import { canonicalDigest } from "../domain/comparisonSemantics.js";
import { AsarArtifactReader } from "../artifacts/AsarArtifactReader.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../artifacts/ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
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
  type IntegrityContradiction,
} from "../domain/artifactGraph.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { scanArtifactInventory } from "./ArtifactInventory.js";
import type { ArtifactIntegrityPolicy } from "./ArtifactInventory/types.js";

/** Local extraction input with the output root chosen by the adapter. */
export interface ArtifactExtractionInput {
  readonly inputPath: string;
  readonly inputFormat: BinaryTarget["format"];
  readonly outputRoot: string;
  /** Integrity mismatches fail unless the caller records and continues. */
  readonly integrity?: ArtifactIntegrityPolicy;
}

/** Extract every regular inventory occurrence into an exclusively owned absent root. */
export const extractArtifact = async (
  input: ArtifactExtractionInput,
  signal?: AbortSignal,
): Promise<ArtifactExtractionResult> => {
  const sourcePath = await realpath(input.inputPath);
  const snapshot = await scanArtifactInventory(sourcePath, {
    signal,
    integrity: input.integrity,
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
    integrityContradictions: snapshot.integrity_contradictions,
  };
  const selected = selectedOccurrences.map((occurrence) => {
    if (
      (occurrence.entry_kind !== "file" && occurrence.entry_kind !== "slice") ||
      occurrence.artifact_id === null ||
      occurrence.encrypted ||
      occurrence.logical_path === "."
    )
      throw new ArtifactReaderFailure(
        "format",
        `Selected occurrence is not an extractable regular child file: ${occurrence.occurrence_id}`,
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
  const reader = await createReader(sourcePath, input.inputFormat);
  const output = await SafeOutputTree.create(input.outputRoot);
  let readerClosed = false;
  const extracted: ExtractedOccurrence[] = [];
  try {
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
    await reader.close();
    readerClosed = true;
    extracted.sort((left, right) =>
      left.relative_path.localeCompare(right.relative_path, "en"),
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
    if (!readerClosed)
      await reader.close().catch((cause: unknown) => {
        // best-effort cleanup: reader close must not mask the extraction failure.
        void cause;
      });
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
  const materializedIds = new Set(
    selected.map(({ occurrence }) => occurrence.occurrence_id),
  );
  const writtenContradictions = inventory.integrityContradictions.filter(
    ({ occurrence_id }) => materializedIds.has(occurrence_id),
  );
  const nestedContradictions = inventory.integrityContradictions.filter(
    ({ occurrence_id }) => !materializedIds.has(occurrence_id),
  );
  const extractionSemantic = {
    source_manifest_id: inventory.manifest.manifest_id,
    selected_occurrence_ids: selected
      .map(({ occurrence }) => occurrence.occurrence_id)
      .sort((left, right) => left.localeCompare(right)),
    files_sha256: canonicalDigest(extracted, "Artifact"),
    output_root_alias: "$OUTPUT_ROOT" as const,
  };
  return artifactExtractionResultSchema.parse({
    manifest: inventory.manifest,
    extraction_manifest: {
      ...extractionSemantic,
      extraction_id: `aex_${canonicalDigest(extractionSemantic, "Artifact")}`,
    },
    output_root: input.outputRoot,
    artifacts: extracted,
    containment_verified: true,
    cleanup: { attempted: false, verified: true, residual_paths: [] },
    provenance: [],
    integrity_contradictions: writtenContradictions,
    limitations: [
      "All regular files in the active artifact were materialized; nested archive contents remain represented by their containing file.",
      ...(writtenContradictions.length === 0
        ? []
        : [
            `${String(writtenContradictions.length)} extracted file(s) contradict declared integrity; their observed bytes were written and are untrusted.`,
          ]),
      ...(nestedContradictions.length === 0
        ? []
        : [
            `${String(nestedContradictions.length)} nested integrity contradiction(s) were not written as their own files (${nestedContradictions.map(({ logical_path }) => logical_path).join(", ")}); the containing archive was materialized instead.`,
          ]),
    ],
  });
};

interface LoadedInventory {
  readonly manifest: ArtifactGraphManifest;
  readonly occurrences: ReadonlyMap<string, ArtifactOccurrence>;
  readonly nodes: ReadonlyMap<string, ArtifactNode>;
  readonly integrityContradictions: readonly IntegrityContradiction[];
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

const createReader = async (
  path: string,
  format: BinaryTarget["format"],
): Promise<ArtifactReader> => {
  if ((await lstat(path)).isDirectory())
    return new DirectoryArtifactReader(path);
  if (format === "asar") return new AsarArtifactReader(path);
  if (
    format === "ipa" ||
    format === "apk" ||
    format === "msix" ||
    format === "appx" ||
    format === "zip"
  )
    return new ZipArtifactReader(path, format);
  if (format === "mach-o") return new MachOSliceArtifactReader(path);
  throw new ArtifactReaderFailure(
    "unavailable",
    `Artifact format has no extraction reader: ${format}`,
  );
};

const preflight = (entry: ArtifactEntry): void => {
  if ((entry.kind !== "file" && entry.kind !== "slice") || entry.encrypted)
    throw new ArtifactReaderFailure(
      "format",
      `Selected artifact entry cannot be read: ${entry.path}`,
    );
};
