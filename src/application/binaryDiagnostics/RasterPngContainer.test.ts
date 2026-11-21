import { expect, it } from "vitest";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { packRasterPng } from "./RasterPngContainer.js";

it.each([0, 6] as const)(
  "frames color type %s with exact caller-compressed bytes and valid CRCs",
  (colorType) => {
    const rows =
      colorType === 0
        ? Buffer.from([0, 12, 255])
        : Buffer.from([0, 12, 12, 12, 255, 255, 255, 255, 0]);
    const compressed = deflateSync(rows);
    const png = packRasterPng(2, 1, colorType, compressed);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks: { type: string; data: Buffer }[] = [];
    for (let offset = 8; offset < png.length;) {
      const size = png.readUInt32BE(offset);
      expect(crc32(png.subarray(offset + 4, offset + 8 + size))).toBe(
        png.readUInt32BE(offset + 8 + size),
      );
      chunks.push({
        type: png.toString("ascii", offset + 4, offset + 8),
        data: png.subarray(offset + 8, offset + 8 + size),
      });
      offset += size + 12;
    }
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect([...chunks[0]!.data]).toEqual([
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      1,
      8,
      colorType,
      0,
      0,
      0,
    ]);
    expect(chunks[1]!.data.equals(compressed)).toBe(true);
    expect(inflateSync(chunks[1]!.data).equals(rows)).toBe(true);
  },
);
