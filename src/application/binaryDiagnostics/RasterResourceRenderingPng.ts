import { crc32, deflateSync } from "node:zlib";
function chunk(type: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, "ascii");
  result.set(data, 8);
  result.writeUInt32BE(
    crc32(result.subarray(4, data.length + 8)),
    data.length + 8,
  );
  return result;
}
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
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(rows, {
        level: 0,
        maxOutputLength: deflateBound(rows.length),
      }),
    ),
    chunk("IEND", new Uint8Array()),
  ]);
}
