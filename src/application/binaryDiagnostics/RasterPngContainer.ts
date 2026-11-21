import { crc32 } from "node:zlib";

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

/** Frame admitted 8-bit grayscale/RGBA rows without changing their compression.
 * The caller owns dimension validation, filtering, compression and memory budget.
 */
export function packRasterPng(
  width: number,
  height: number,
  colorType: 0 | 6,
  compressedRows: Uint8Array,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", compressedRows),
    chunk("IEND", new Uint8Array()),
  ]);
}
