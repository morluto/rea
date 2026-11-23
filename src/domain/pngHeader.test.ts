import { crc32 } from "node:zlib";
import { expect, it } from "vitest";
import { readPngHeaderDimensions } from "./pngHeader.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
  "base64",
);

it("reads encoded dimensions without changing screenshot bytes", () => {
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(257, 16);
  bytes.writeUInt32BE(129, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  const original = Buffer.from(bytes);
  expect(readPngHeaderDimensions(bytes)).toEqual({ width: 257, height: 129 });
  expect(bytes.equals(original)).toBe(true);
});

it("rejects a high-bit lookalike at any position in the IHDR chunk name", () => {
  for (const offset of [12, 13, 14, 15]) {
    const bytes = Buffer.from(png);
    bytes[offset] = (bytes[offset] ?? 0) | 0x80;
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
    expect(
      readPngHeaderDimensions(bytes),
      `chunk-name offset ${offset}`,
    ).toBeUndefined();
  }
});

it("rejects incomplete or corrupted IHDR data", () => {
  const badSignature = Buffer.from(png);
  badSignature[0] = 0;
  const badChecksum = Buffer.from(png);
  badChecksum[29] = (badChecksum[29] ?? 0) ^ 1;
  expect(readPngHeaderDimensions(png.subarray(0, 32))).toBeUndefined();
  expect(readPngHeaderDimensions(badSignature)).toBeUndefined();
  expect(readPngHeaderDimensions(badChecksum)).toBeUndefined();
});

it("requires the fixed IHDR data length", () => {
  for (const length of [0, 12, 14, 0xffff_ffff]) {
    const bytes = Buffer.from(png);
    bytes.writeUInt32BE(length, 8);
    expect(
      readPngHeaderDimensions(bytes),
      `declared length ${length}`,
    ).toBeUndefined();
  }
});

it("requires both dimensions to be positive PNG integers", () => {
  for (const offset of [16, 20]) {
    for (const dimension of [0, 0x8000_0000]) {
      const bytes = Buffer.from(png);
      bytes.writeUInt32BE(dimension, offset);
      bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
      expect(
        readPngHeaderDimensions(bytes),
        `dimension ${dimension} at ${offset}`,
      ).toBeUndefined();
    }
  }
});

it("accepts the largest dimension representable by the PNG specification", () => {
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(0x7fff_ffff, 16);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  expect(readPngHeaderDimensions(bytes)).toEqual({
    width: 0x7fff_ffff,
    height: 1,
  });
});
