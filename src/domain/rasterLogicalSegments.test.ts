import { crc32 } from "node:zlib";
import { fgsRecordFixture } from "../../tests/fixtures/structuredRaster.js";
import { expect, it } from "vitest";
import {
  materializeRasterSegments,
  parseFgsRasterSegments,
} from "./rasterLogicalSegments.js";
it("preserves discontiguous provenance and rejects gap-as-data", () => {
  const r = materializeRasterSegments(Uint8Array.from([1, 2, 3, 4]), [
    { logicalOffset: 100, fileOffset: 0, length: 2 },
    { logicalOffset: 104, fileOffset: 2, length: 2 },
  ]);
  expect(r.logicalBase).toBe(100);
  expect([...r.bytes]).toEqual([1, 2, 0, 0, 3, 4]);
  expect(r.coverage).toEqual([
    { offset: 0, length: 2 },
    { offset: 4, length: 2 },
  ]);
});
it("rejects overlaps, out of range and oversized spans before allocation", () => {
  for (const segments of [
    [
      { logicalOffset: 0, fileOffset: 0, length: 3 },
      { logicalOffset: 2, fileOffset: 3, length: 1 },
    ],
    [
      { logicalOffset: 0, fileOffset: 0, length: 3 },
      { logicalOffset: 4, fileOffset: 2, length: 1 },
    ],
    [
      { logicalOffset: 0, fileOffset: 0, length: 1 },
      { logicalOffset: 20000000, fileOffset: 2, length: 1 },
    ],
    [{ logicalOffset: 0, fileOffset: 3, length: 2 }],
  ])
    expect(() =>
      materializeRasterSegments(new Uint8Array(4), segments),
    ).toThrow(RangeError);
});
it("requires footer integrity before interpreting FGS record markers", () => {
  expect(() => parseFgsRasterSegments(new Uint8Array(64))).toThrow(/footer/);
  expect(() => parseFgsRasterSegments(new Uint8Array(0))).toThrow();
});

it("validates FGS monotonic records, declared length, and CRC with independent encoder", () => {
  const valid = fgsRecordFixture(new Uint8Array(88));
  expect(parseFgsRasterSegments(valid)).toHaveLength(2);
  for (const change of ["crc", "size", "overlap", "length"]) {
    const bytes = Buffer.from(valid);
    if (change === "crc") bytes[20] = 1;
    if (change === "size") bytes.writeUInt32LE(1, bytes.length - 8);
    if (change === "overlap") bytes.writeUInt32LE(4096, 56 + 8);
    if (change === "length") bytes.writeUInt32LE(48, 4);
    if (change !== "crc")
      bytes.writeUInt32LE(
        crc32(bytes.subarray(0, bytes.length - 4)),
        bytes.length - 4,
      );
    expect(() => parseFgsRasterSegments(bytes)).toThrow(RangeError);
  }
});

it("rejects a truncated FGS record even with a repaired footer size and CRC", () => {
  const valid = fgsRecordFixture(new Uint8Array(88));
  const truncated = Buffer.concat([
    valid.subarray(0, valid.length - 20),
    valid.subarray(valid.length - 16),
  ]);
  truncated.writeUInt32LE(truncated.length, truncated.length - 8);
  truncated.writeUInt32LE(
    crc32(truncated.subarray(0, truncated.length - 4)),
    truncated.length - 4,
  );
  expect(() => parseFgsRasterSegments(truncated)).toThrow(/Invalid/);
});
