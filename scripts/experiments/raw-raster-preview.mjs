// Experimental harness only: not registered in REA CLI, MCP or provider catalogs.
// Run with: node --import tsx scripts/experiments/raw-raster-preview.mjs NEW_DIRECTORY
import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { admitRawRaster, decodeRawRaster } from "../../src/domain/rawRaster.ts";

export const DEFAULT_MAX_MEMORY_MIB = 64;
export const MAX_MEMORY_MIB = 512;

/** Conservative working-buffer estimate, not a process RSS guarantee. */
export function admitPreview(sourceLength, input, options = {}) {
  const maxMemoryMiB = options.maxMemoryMiB ?? DEFAULT_MAX_MEMORY_MIB;
  if (
    !Number.isInteger(maxMemoryMiB) ||
    maxMemoryMiB < 1 ||
    maxMemoryMiB > MAX_MEMORY_MIB
  )
    return {
      ok: false,
      error: {
        kind: "malformed",
        message: `maxMemoryMiB must be an integer from 1 to ${MAX_MEMORY_MIB}.`,
      },
    };
  const maxBytes = maxMemoryMiB * 1024 * 1024;
  const allowance = { maxSourceBytes: maxBytes, maxOutputBytes: maxBytes };
  const admission = admitRawRaster(sourceLength, input, allowance);
  if (!admission.ok) {
    if (admission.error.kind === "capacity")
      return {
        ok: false,
        error: {
          ...admission.error,
          message: `${admission.error.message} Reduce the selected range/layout or raise --max-memory-mib (maximum ${MAX_MEMORY_MIB}).`,
        },
      };
    return admission;
  }
  const { layout } = admission.value;
  const rgba = layout.width * layout.height * 4;
  const rows = rgba + layout.height;
  // zlib compressBound for default deflate parameters, without 32-bit shifts.
  const compressed =
    rows +
    Math.floor(rows / 4096) +
    Math.floor(rows / 16384) +
    Math.floor(rows / 33554432) +
    13;
  // Include deflate chunk storage/concatenation, CRC/chunk/final PNG copies,
  // plus 512 KiB for zlib workspace and small framing buffers.
  const estimatedBytes =
    layout.length + rgba + rows + 5 * (compressed + 64) + 512 * 1024;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > maxBytes)
    return {
      ok: false,
      error: {
        kind: "capacity",
        message: `Estimated PNG working buffers require ${Math.ceil(estimatedBytes / 1024 / 1024)} MiB, above the ${maxMemoryMiB} MiB budget. Reduce the selected layout or raise --max-memory-mib (maximum ${MAX_MEMORY_MIB}).`,
      },
    };
  return {
    ok: true,
    value: { ...admission.value, allowance, estimatedBytes, maxMemoryMiB },
  };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}
function encodePng({ rgba, layout: { width, height } }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    rows.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (1 + width * 4) + 1,
    );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function previewRawRasterExperiment(source, input, options = {}) {
  const admission = admitPreview(source.byteLength, input, options);
  if (!admission.ok) return admission;
  const decoded = decodeRawRaster(source, input, admission.value.allowance);
  if (!decoded.ok) return decoded;
  const png = encodePng(decoded.value);
  const { offset, length, ...decoding } = decoded.value.layout;
  return {
    ok: true,
    value: {
      png,
      manifest: {
        schema: "rea-raw-raster-experiment-v0",
        memory: {
          maxMemoryMiB: admission.value.maxMemoryMiB,
          estimatedWorkingBytes: admission.value.estimatedBytes,
          scope:
            "Conservative working-buffer estimate, not a process RSS guarantee",
        },
        sourceRange: {
          offset,
          length,
          sha256: sha256(source.subarray(offset, offset + length)),
        },
        decoding: {
          ...decoding,
          alpha: "straight",
          consumedSpan: decoded.value.consumedSpan,
        },
        output: {
          format: "png",
          pixels: "RGBA8",
          precisionLoss: false,
          sha256: sha256(png),
        },
        identityStatus:
          "Not a REA artifact/subject identity; integration decision pending",
      },
    },
  };
}

export async function writeSyntheticPreview(outputDirectory) {
  // Red, green / blue, white, with a prefix and one inter-row padding byte.
  const source = Uint8Array.from([
    99, 255, 0, 0, 0, 255, 0, 42, 0, 0, 255, 255, 255, 255,
  ]);
  const result = previewRawRasterExperiment(source, {
    offset: 1,
    length: 13,
    width: 2,
    height: 2,
    format: "rgb888",
    stride: 7,
    rowOrder: "top-down",
  });
  if (!result.ok) throw new Error(result.error.message);
  await writePreviewResult(result.value, outputDirectory);
}

export async function writePreviewResult(preview, outputDirectory) {
  // Serialize before claiming a directory. Existing directories are never touched.
  const manifest = JSON.stringify(preview.manifest, null, 2) + "\n";
  await mkdir(outputDirectory);
  try {
    await writeFile(
      join(outputDirectory, ".incomplete"),
      "This raster output is incomplete. Do not use it as a completed export.\n",
      { flag: "wx" },
    );
    await writeFile(join(outputDirectory, "preview.png"), preview.png, {
      flag: "wx",
    });
    await writeFile(join(outputDirectory, "manifest.json"), manifest, {
      flag: "wx",
    });
    await unlink(join(outputDirectory, ".incomplete"));
  } catch (cause) {
    throw new Error(
      `Incomplete output retained at ${outputDirectory}. Inspect or remove that directory before retrying: ${cause.message}`,
      { cause },
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: node --import tsx scripts/experiments/raw-raster-preview.mjs NEW_DIRECTORY",
    );
  await writeSyntheticPreview(resolve(process.argv[2]));
  console.log(
    "Created preview.png and manifest.json from synthetic bytes only.",
  );
}
