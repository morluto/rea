import { deflateSync } from "node:zlib";
import { packRasterPng } from "./RasterPngContainer.js";
const deflateBound = (bytes: number) =>
  bytes +
  Math.ceil(bytes / 4096) +
  Math.ceil(bytes / 16384) +
  Math.ceil(bytes / 33554432) +
  64;
/** Conservative working-buffer bound for the fixed stored-DEFLATE encoder. */
export function rasterPngWorkingBytes(width: number, height: number): number {
  const rgba = width * height * 4,
    rows = rgba + height;
  const compressed = deflateBound(rows);
  // RGBA, filtered rows, compressed payload, IDAT chunk, final PNG.
  return rgba + rows + compressed * 3 + 128;
}
/** Caller validates dimensions, RGBA size and working allowance before allocation. */
export function encodeRasterRgbaPng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Buffer {
  const rowBytes = width * 4,
    rows = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++)
    rows.set(
      rgba.subarray(y * rowBytes, (y + 1) * rowBytes),
      y * (rowBytes + 1) + 1,
    );
  return packRasterPng(
    width,
    height,
    6,
    deflateSync(rows, {
      level: 0,
      maxOutputLength: deflateBound(rows.length),
    }),
  );
}
