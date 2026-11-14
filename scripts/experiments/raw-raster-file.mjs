// Unregistered experimental file workflow. No target execution or source writes.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ArtifactFileSource } from "../../src/artifacts/ArtifactFileSource.ts";
import { readArtifactRange } from "../../src/artifacts/ArtifactCarrierRange.ts";
import { regularFileState } from "../../src/filesystem/RegularFile.ts";
import { admitRawRaster } from "../../src/domain/rawRaster.ts";
import {
  EXPERIMENT_ALLOWANCE,
  previewRawRasterExperiment,
  writePreviewResult,
} from "./raw-raster-preview.mjs";

/** Reads only the admitted selected range. Rejects leaf symlinks and non-files.
 * Metadata stability is observed before/after reading, not an immutable snapshot
 * guarantee. Hashes bind the exact decoded bytes, not a whole-file REA subject.
 */
export async function previewRawRasterFile(inputPath, inputLayout) {
  const source = new ArtifactFileSource(inputPath, "Experimental raster");
  try {
    const descriptor = await source.readSelectedPath();
    const admission = admitRawRaster(
      descriptor.initial.size,
      inputLayout,
      EXPERIMENT_ALLOWANCE,
    );
    if (!admission.ok)
      throw new Error(admission.error.message, { cause: admission.error });
    const { layout } = admission.value;
    const bytes = await readArtifactRange(
      {
        handle: descriptor.handle,
        fileSize: descriptor.initial.size,
        signal: undefined,
      },
      layout.offset,
      layout.length,
    );
    if (bytes === undefined)
      throw new Error("Selected raster range was truncated during reading.");
    // Rechecks both the descriptor and the caller-selected path against admission.
    await source.readSelectedPath();
    const preview = previewRawRasterExperiment(bytes, { ...layout, offset: 0 });
    if (!preview.ok)
      throw new Error(preview.error.message, { cause: preview.error });
    return {
      png: preview.value.png,
      manifest: {
        ...preview.value.manifest,
        sourcePath: inputPath,
        sourceRange: {
          ...preview.value.manifest.sourceRange,
          offset: layout.offset,
        },
        sourceSnapshot: {
          ...regularFileState(descriptor.initial),
          stability:
            "Descriptor and selected-path metadata matched before and after the selected-range read; no immutable snapshot guarantee.",
        },
      },
    };
  } finally {
    await source.close();
  }
}

export async function writeFilePreview(inputPath, layout, outputDirectory) {
  const preview = await previewRawRasterFile(inputPath, layout);
  await writePreviewResult(preview, outputDirectory);
}

async function readLayout(path) {
  const source = new ArtifactFileSource(path, "Experimental raster layout");
  try {
    const descriptor = await source.readSelectedPath();
    if (descriptor.initial.size > 64 * 1024)
      throw new Error("Layout JSON exceeds the experimental 64 KiB allowance.");
    const bytes = await readArtifactRange(
      {
        handle: descriptor.handle,
        fileSize: descriptor.initial.size,
        signal: undefined,
      },
      0,
      descriptor.initial.size,
    );
    if (bytes === undefined)
      throw new Error("Layout JSON was truncated during reading.");
    await source.readSelectedPath();
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await source.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.length !== 5)
    throw new Error(
      "Usage: node --import tsx scripts/experiments/raw-raster-file.mjs INPUT_FILE LAYOUT_JSON NEW_OUTPUT_DIRECTORY",
    );
  const layout = await readLayout(process.argv[3]);
  await writeFilePreview(process.argv[2], layout, resolve(process.argv[4]));
  console.log(
    "Created preview.png and manifest.json from the selected file range.",
  );
}
