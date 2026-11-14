// Experimental harness only: not registered in REA CLI, MCP or provider catalogs.
// Run with: node --import tsx scripts/experiments/raw-raster-preview.mjs NEW_DIRECTORY
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { decodeRawRaster } from "../../src/domain/rawRaster.ts";

export const EXPERIMENT_ALLOWANCE = Object.freeze({
  maxSourceBytes: 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
});

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

export function previewRawRasterExperiment(source, input) {
  // Small harness-only allowances, not proposed REA settings. At most 1 MiB RGBA,
  // 1.25 MiB filter rows, plus bounded compression/chunk/concatenation copies.
  const decoded = decodeRawRaster(source, input, EXPERIMENT_ALLOWANCE);
  if (!decoded.ok) return decoded;
  const png = encodePng(decoded.value);
  const { offset, length, ...decoding } = decoded.value.layout;
  return {
    ok: true,
    value: {
      png,
      manifest: {
        schema: "rea-raw-raster-experiment-v0",
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
  // Exclusive directory and files; never replace an existing result or source.
  await mkdir(outputDirectory);
  await writeFile(join(outputDirectory, "preview.png"), preview.png, {
    flag: "wx",
  });
  await writeFile(
    join(outputDirectory, "manifest.json"),
    JSON.stringify(preview.manifest, null, 2) + "\n",
    { flag: "wx" },
  );
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
