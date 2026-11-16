// Unregistered experimental file workflow. No target execution or source writes.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ArtifactFileSource,
  assertArtifactFileSelectedSource,
  ArtifactResourceScope,
  resolveArtifactSourcePath,
} from "../../src/resources/index.ts";
import { readArtifactRange } from "../../src/artifacts/ArtifactCarrierRange.ts";
import {
  admitPreview,
  previewRawRasterExperiment,
  writePreviewResult,
} from "./raw-raster-preview.mjs";

// Keep both the primary failure and the exact cleanup capability on failure.
// The existing resource scope owns retry/idempotence; do not invent another
// descriptor owner or discard a source whose close did not complete.
async function withFileSource(path, label, operation) {
  const source = new ArtifactFileSource(path, label);
  const resources = new ArtifactResourceScope();
  let outcome = { kind: "completed" };
  let result;
  try {
    result = await operation(source);
  } catch (cause) {
    outcome = { kind: "failed", cause };
  }
  const cleanup = await resources.release({
    kind: "lease",
    resource: label,
    lease: { release: () => source.close() },
  });
  if (cleanup.kind === "failed")
    throw resources.cleanupFailure(outcome, [cleanup]);
  if (outcome.kind === "failed") throw outcome.cause;
  return result;
}

/** Reads only the admitted selected range. Rejects leaf symlinks and non-files.
 * Metadata stability is observed before/after reading, not an immutable snapshot
 * guarantee. Hashes bind the exact decoded bytes, not a whole-file REA subject.
 */
export async function previewRawRasterFile(
  inputPath,
  inputLayout,
  options = {},
) {
  if (
    options.includeSourcePaths !== undefined &&
    typeof options.includeSourcePaths !== "boolean"
  )
    throw new Error(
      "includeSourcePaths must be a boolean; only true opts in to exporting personal source paths.",
    );
  // Let native lookup interpret the caller's spelling; do not normalize file/.. .
  return withFileSource(inputPath, "Experimental raster", async (source) => {
    const descriptor = await source.readSelectedPath();
    const sourceResolvedPath = await resolveArtifactSourcePath(inputPath);
    await assertArtifactFileSelectedSource(
      sourceResolvedPath,
      descriptor,
      "Experimental raster resolved path",
    );
    const admission = admitPreview(
      descriptor.initial.size,
      inputLayout,
      options,
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
    await assertArtifactFileSelectedSource(
      sourceResolvedPath,
      descriptor,
      "Experimental raster resolved path",
    );
    const preview = previewRawRasterExperiment(
      bytes,
      { ...layout, offset: 0 },
      options,
    );
    if (!preview.ok)
      throw new Error(preview.error.message, { cause: preview.error });
    return {
      png: preview.value.png,
      manifest: {
        ...preview.value.manifest,
        ...(options.includeSourcePaths === true
          ? {
              sourcePath: inputPath,
              sourceResolvedPath,
              sourcePathWarning:
                "Source paths are included by explicit opt-in and may contain personal information. Review before sharing.",
            }
          : {}),
        sourceRange: {
          ...preview.value.manifest.sourceRange,
          offset: layout.offset,
        },
        sourceSnapshot: {
          size: descriptor.initial.size,
          stability:
            "Descriptor and selected-path metadata matched before and after the selected-range read; no immutable snapshot guarantee.",
        },
      },
    };
  });
}

export async function writeFilePreview(
  inputPath,
  layout,
  outputDirectory,
  options = {},
) {
  const preview = await previewRawRasterFile(inputPath, layout, options);
  await writePreviewResult(preview, outputDirectory);
}

async function readLayout(path) {
  return withFileSource(path, "Experimental raster layout", async (source) => {
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
  });
}

const USAGE = `Usage: node --import tsx scripts/experiments/raw-raster-file.mjs [--max-memory-mib N] [--include-source-paths] INPUT_FILE LAYOUT_JSON NEW_OUTPUT_DIRECTORY

Read an explicit raw-pixel range and export preview.png plus manifest.json.
Layout fields: offset, length, width, height, stride, format, rowOrder.
Formats: gray8, rgb888, bgr888, rgba8888, bgra8888, indexed4.
indexed4 requires bitOrder (msb-first or lsb-first) and palette: exactly 16 [R,G,B,A]
tuples, each component an integer 0..255. Rows use ceil(width/2) bytes; an odd
width ignores the unused last nibble. Palette alpha is straight, not premultiplied.
rowOrder: top-down or bottom-up. offset/length/stride are bytes; width/height are pixels.
Example layout JSON: {"offset":0,"length":12,"width":2,"height":2,"stride":6,"format":"rgb888","rowOrder":"top-down"}
--max-memory-mib N: estimated working-buffer budget (default 64, integer 1..512).
The budget includes selected bytes, RGBA, PNG filter/compression/copy buffers;
it is not a process RSS limit. Source files are read-only; leaf symlinks are rejected.
Output directory must not exist. Failed exports report the retained directory;
.incomplete remains when it could be created.
Manifest omits source paths, filenames and filesystem identifiers by default.
--include-source-paths: explicitly include original and resolved source paths.
Warning: these paths may contain personal information; review before sharing.
Experimental script only; not registered as a REA CLI/MCP command.`;

export async function runFilePreviewCli(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE);
    return;
  }
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-memory-mib") {
      if (options.maxMemoryMiB !== undefined || i + 1 >= args.length)
        throw new Error(
          "Supply --max-memory-mib once with an integer from 1 to 512. Use --help for usage.",
        );
      options.maxMemoryMiB = Number(args[++i]);
      if (
        !Number.isInteger(options.maxMemoryMiB) ||
        options.maxMemoryMiB < 1 ||
        options.maxMemoryMiB > 512
      )
        throw new Error("--max-memory-mib must be an integer from 1 to 512.");
    } else if (args[i] === "--include-source-paths") {
      if (options.includeSourcePaths !== undefined)
        throw new Error(
          "Supply --include-source-paths at most once; it is a flag without a value.",
        );
      options.includeSourcePaths = true;
    } else if (args[i].startsWith("--"))
      throw new Error(`Unknown option ${args[i]}. Use --help for usage.`);
    else positional.push(args[i]);
  }
  if (positional.length !== 3)
    throw new Error(
      "Expected INPUT_FILE LAYOUT_JSON NEW_OUTPUT_DIRECTORY. Use --help for usage.",
    );
  if (options.includeSourcePaths === true)
    console.error(
      "Warning: source paths will be included in the manifest and may contain personal information; review before sharing.",
    );
  let layout;
  try {
    layout = await readLayout(positional[1]);
  } catch (cause) {
    throw new Error(
      `Cannot read layout JSON ${positional[1]}: ${cause.message}`,
      { cause },
    );
  }
  await writeFilePreview(
    positional[0],
    layout,
    resolve(positional[2]),
    options,
  );
  console.log(
    "Created preview.png and manifest.json from the selected file range.",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runFilePreviewCli(process.argv.slice(2));
  } catch (error) {
    console.error(`Raster preview: ${error.message}`);
    process.exitCode = 1;
  }
}
