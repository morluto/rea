import { crc32 } from "node:zlib";
import { fgsRecordFixture } from "../../tests/fixtures/structuredRaster.js";
import { expect, it } from "vitest";
import { ParseFailureError } from "./parseFailure.js";
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
    ).toThrow(ParseFailureError);
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
    expect(() => parseFgsRasterSegments(bytes)).toThrow(ParseFailureError);
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
  expect(() => parseFgsRasterSegments(truncated)).toThrow(/Truncated/);
});

it.each([
  ["footer", new Uint8Array(8), "truncated", "fgs-records"],
  ["integrity", new Uint8Array(64), "malformed", "fgs-records"],
  ["input bytes", new Uint8Array(16 * 1024 * 1024 + 1), "limit", "fgs-records"],
] as const)(
  "preserves typed %s parser failures",
  (_name, bytes, kind, format) => {
    try {
      parseFgsRasterSegments(bytes);
      throw new Error("Expected parser refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ParseFailureError);
      expect(cause).toMatchObject({ failure: { kind, format } });
    }
  },
);
it("reports a logical span limit as a named decode budget, not malformed mapping", () => {
  expect(() =>
    materializeRasterSegments(new Uint8Array(2), [
      { logicalOffset: 0, fileOffset: 0, length: 1 },
      { logicalOffset: 16 * 1024 * 1024, fileOffset: 1, length: 1 },
    ]),
  ).toThrow(
    expect.objectContaining({
      failure: {
        kind: "limit",
        format: "raster-logical-segments",
        detail: expect.any(String),
        limit: {
          name: "raster-logical-span-bytes",
          maximum: 16 * 1024 * 1024,
          required: 16 * 1024 * 1024 + 1,
        },
      },
    }),
  );
});
it("preserves truncated record facts after valid footer integrity", () => {
  const valid = fgsRecordFixture(new Uint8Array(88));
  const bytes = Buffer.concat([
    valid.subarray(0, valid.length - 20),
    valid.subarray(valid.length - 16),
  ]);
  bytes.writeUInt32LE(bytes.length, bytes.length - 8);
  bytes.writeUInt32LE(
    crc32(bytes.subarray(0, bytes.length - 4)),
    bytes.length - 4,
  );
  expect(() => parseFgsRasterSegments(bytes)).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "truncated",
        format: "fgs-records",
        offset: 56,
        field: "record.payload",
      }),
    }),
  );
});
it("names the segment-count refusal before iterating or copying entries", () => {
  const segments = Array.from({ length: 500001 }, () => ({
    logicalOffset: 0,
    fileOffset: 0,
    length: 1,
  }));
  expect(() => materializeRasterSegments(new Uint8Array(1), segments)).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: {
          name: "raster-logical-segment-count",
          maximum: 500000,
          required: 500001,
        },
      }),
    }),
  );
});
it("distinguishes a truncated record header from malformed record lengths", () => {
  const repair = (body: Buffer) => {
    const footer = fgsRecordFixture(new Uint8Array(4)).subarray(-16),
      bytes = Buffer.concat([body, footer]);
    bytes.writeUInt32LE(bytes.length, bytes.length - 8);
    bytes.writeUInt32LE(
      crc32(bytes.subarray(0, bytes.length - 4)),
      bytes.length - 4,
    );
    return bytes;
  };
  expect(() =>
    parseFgsRasterSegments(repair(Buffer.from([255, 255, 255, 0x24]))),
  ).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "truncated",
        offset: 0,
        field: "record.header",
      }),
    }),
  );
  const header = Buffer.alloc(12);
  header.set([255, 255, 255, 0x24]);
  header.writeUInt32LE(3, 4);
  expect(() => parseFgsRasterSegments(repair(header))).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "malformed",
        offset: 0,
        field: "record",
      }),
    }),
  );
});

it("walks exact segment intersections and retains full-table indices", async () => {
  const { walkRasterLogicalSegments } =
    await import("./rasterLogicalSegments.js");
  const segments = [
    { logicalOffset: 100, fileOffset: 20, length: 4 },
    { logicalOffset: 104, fileOffset: 60, length: 4 },
    { logicalOffset: 110, fileOffset: 80, length: 2 },
  ];
  const spans: number[][] = [];
  expect(
    walkRasterLogicalSegments(segments, 102, 6, Infinity, (s, offset, length) =>
      spans.push([s.fileOffset + offset - s.logicalOffset, length]),
    ),
  ).toEqual({ firstSegment: 0, segmentCount: 2, complete: true });
  expect(spans).toEqual([
    [22, 2],
    [60, 4],
  ]);
  expect(walkRasterLogicalSegments(segments, 104, 8)).toEqual({
    firstSegment: 1,
    segmentCount: 1,
    complete: false,
  });
  expect(walkRasterLogicalSegments(segments, 108, 4)).toEqual({
    firstSegment: 2,
    segmentCount: 0,
    complete: false,
  });
  expect(walkRasterLogicalSegments(segments, 112, 1)).toEqual({
    firstSegment: 3,
    segmentCount: 0,
    complete: false,
  });
});

it("separates bounded publication from a complete traversal beyond 256 spans", async () => {
  const { walkRasterLogicalSegments } =
    await import("./rasterLogicalSegments.js");
  const segments = Array.from({ length: 300 }, (_, i) => ({
    logicalOffset: 100 + i,
    fileOffset: i * 2,
    length: 1,
  }));
  expect(walkRasterLogicalSegments(segments, 100, 300, 256)).toEqual({
    firstSegment: 0,
    segmentCount: 256,
    complete: false,
  });
  expect(walkRasterLogicalSegments(segments, 100, 256, 256)).toEqual({
    firstSegment: 0,
    segmentCount: 256,
    complete: true,
  });
  expect(walkRasterLogicalSegments(segments, 100, 300)).toEqual({
    firstSegment: 0,
    segmentCount: 300,
    complete: true,
  });
  expect(walkRasterLogicalSegments(segments, 100, 1, 0)).toEqual({
    firstSegment: 0,
    segmentCount: 0,
    complete: false,
  });
});
