import { expect, it } from "vitest";

import { ParseFailureError } from "./parseFailure.js";
import { buildNro, buildNso, MODULE_ID } from "./switchExecutable.fixture.js";
import {
  hasMod0Magic,
  hasNroMagic,
  hasNsoMagic,
  NRO_HEADER_SIZE,
  nroMod0MagicExtent,
  parseNroAssetSection,
  parseNroHeader,
  parseNsoHeader,
  parseTextMod0Offset,
} from "./switchExecutable.js";

it("parses NSO segment headers, flags and the module id", () => {
  const bytes = buildNso();
  expect(hasNsoMagic(bytes)).toBe(true);
  const parsed = parseNsoHeader(bytes, bytes.length);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value).toMatchObject({
    format: "nso",
    flags: 0b111101,
    unknownFlags: 0,
    moduleId: MODULE_ID.toString("hex"),
    bssSize: 0x40,
  });
  expect(
    parsed.value.segments.map((segment) => [
      segment.name,
      segment.memoryOffset,
      segment.size,
      segment.compressed,
      segment.hashChecked,
      segment.truncated,
    ]),
  ).toEqual([
    ["text", 0, 32, true, true, false],
    ["rodata", 0x1000, 22, false, true, false],
    ["data", 0x2000, 13, true, true, false],
  ]);
  // Literal-only LZ4 adds one token byte, so stored sizes exceed loaded ones.
  expect(parsed.value.segments[0]?.fileSize).toBe(34);
});

it("keeps unknown NSO flag bits and marks a short segment as truncated", () => {
  const bytes = buildNso({ extraFlags: 0x100, truncateBy: 4 });
  const parsed = parseNsoHeader(bytes, bytes.length);
  expect(parsed).toMatchObject({
    ok: true,
    value: {
      unknownFlags: 0x100,
      segments: [
        { truncated: false },
        { truncated: false },
        { truncated: true },
      ],
    },
  });
});

it("refuses a truncated NSO header and a segment overlapping the header", () => {
  const truncated = parseNsoHeader(buildNso().subarray(0, 0x80), 0x80);
  expect(truncated.ok).toBe(false);
  if (!truncated.ok) {
    expect(truncated.error).toBeInstanceOf(ParseFailureError);
    expect(truncated.error.failure).toEqual({
      kind: "truncated",
      format: "nso",
      detail: expect.stringContaining("truncated"),
      offset: 0,
      field: "header",
      extent: { availableBytes: 0x80, requiredBytes: 0x100 },
    });
  }
  const overlap = buildNso();
  overlap.writeUInt32LE(0x20, 0x10);
  const overlapping = parseNsoHeader(overlap, overlap.length);
  expect(overlapping.ok).toBe(false);
  if (!overlapping.ok) {
    expect(overlapping.error).toBeInstanceOf(ParseFailureError);
    expect(overlapping.error.failure).toEqual({
      kind: "malformed",
      format: "nso",
      detail: expect.stringContaining("overlaps the header"),
      offset: 0x10,
      field: "text_segment.file_offset",
    });
  }
});

it("parses an NRO header and its ASET section", () => {
  const icon = Buffer.from("jpeg");
  const nacp = Buffer.alloc(16, 1);
  const bytes = buildNro({ assets: { icon, nacp } });
  expect(hasNroMagic(bytes)).toBe(true);
  expect(hasNsoMagic(bytes)).toBe(false);
  const parsed = parseNroHeader(
    bytes.subarray(0, NRO_HEADER_SIZE),
    bytes.length,
  );
  if (!parsed.ok) throw parsed.error;
  const header = parsed.value;
  expect(header).toMatchObject({
    format: "nro",
    mod0Offset: 0x80,
    moduleId: MODULE_ID.toString("hex"),
    segments: [
      { name: "text", fileOffset: 0x80, size: 0x20, truncated: false },
      { name: "rodata", fileOffset: 0xa0, size: 10 },
      { name: "data", fileOffset: 0xaa, size: 8 },
    ],
  });
  const assets = parseNroAssetSection(
    bytes.subarray(header.size),
    header.size,
    bytes.length,
  );
  expect(assets).toEqual({
    ok: true,
    value: {
      offset: header.size,
      version: 0,
      rejected: [],
      assets: [
        {
          name: "icon",
          fileOffset: header.size + 0x38,
          size: 4,
          truncated: false,
        },
        {
          name: "nacp",
          fileOffset: header.size + 0x3c,
          size: 16,
          truncated: false,
        },
      ],
    },
  });
});

it("keeps valid NRO assets when a declared range is unsafe", () => {
  const bytes = buildNro({
    assets: { icon: Buffer.from("jpeg"), nacp: Buffer.alloc(16, 1) },
  });
  const offset = bytes.readUInt32LE(0x18);
  const aset = bytes.subarray(offset);
  aset.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) - BigInt(offset), 0x28);
  aset.writeBigUInt64LE(1n, 0x30);

  expect(parseNroAssetSection(aset, offset, bytes.length)).toMatchObject({
    ok: true,
    value: {
      assets: [
        { name: "icon", truncated: false },
        { name: "nacp", truncated: false },
      ],
      rejected: ["NRO romfs asset range exceeds a safe file offset"],
    },
  });
});

it("returns no asset section when the trailer is not ASET", () => {
  expect(parseNroAssetSection(Buffer.from("JUNKJUNK"), 0x100, 0x108)).toEqual({
    ok: true,
    value: undefined,
  });
});

it("refuses an NRO whose segment ends past the declared image size", () => {
  const bytes = buildNro();
  bytes.writeUInt32LE(0x1000, 0x34);
  const parsed = parseNroHeader(bytes, bytes.length);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.error).toBeInstanceOf(ParseFailureError);
    expect(parsed.error.failure).toEqual({
      kind: "malformed",
      format: "nro",
      detail: expect.stringContaining("past the declared image size"),
      offset: 0x30,
      field: "data_segment",
    });
  }
});

it("reports structured parse failure facts for missing magic, small NRO size, and truncated headers", () => {
  const missingNsoMagic = parseNsoHeader(Buffer.alloc(0x100), 0x100);
  expect(missingNsoMagic.ok).toBe(false);
  if (!missingNsoMagic.ok) {
    expect(missingNsoMagic.error).toBeInstanceOf(ParseFailureError);
    expect(missingNsoMagic.error.failure).toEqual({
      kind: "malformed",
      format: "nso",
      detail: "NSO magic NSO0 is missing",
      offset: 0,
      field: "magic",
    });
  }

  const missingNroMagic = parseNroHeader(Buffer.alloc(0x80), 0x80);
  expect(missingNroMagic.ok).toBe(false);
  if (!missingNroMagic.ok) {
    expect(missingNroMagic.error).toBeInstanceOf(ParseFailureError);
    expect(missingNroMagic.error.failure).toEqual({
      kind: "malformed",
      format: "nro",
      detail: "NRO magic NRO0 is missing",
      offset: 0x10,
      field: "magic",
    });
  }

  const truncatedNro = parseNroHeader(buildNro().subarray(0, 0x40), 0x40);
  expect(truncatedNro.ok).toBe(false);
  if (!truncatedNro.ok) {
    expect(truncatedNro.error).toBeInstanceOf(ParseFailureError);
    expect(truncatedNro.error.failure).toEqual({
      kind: "truncated",
      format: "nro",
      detail: expect.stringContaining("truncated"),
      offset: 0,
      field: "header",
      extent: { availableBytes: 0x40, requiredBytes: NRO_HEADER_SIZE },
    });
  }

  const smallNro = buildNro();
  smallNro.writeUInt32LE(0x40, 0x18);
  const parsedSmallNro = parseNroHeader(smallNro, smallNro.length);
  expect(parsedSmallNro.ok).toBe(false);
  if (!parsedSmallNro.ok) {
    expect(parsedSmallNro.error).toBeInstanceOf(ParseFailureError);
    expect(parsedSmallNro.error.failure).toEqual({
      kind: "malformed",
      format: "nro",
      detail: expect.stringContaining("smaller than"),
      offset: 0x18,
      field: "size",
    });
  }

  const truncatedAset = parseNroAssetSection(
    Buffer.from("ASET\0\0\0\0"),
    0x100,
    0x108,
  );
  expect(truncatedAset.ok).toBe(false);
  if (!truncatedAset.ok) {
    expect(truncatedAset.error).toBeInstanceOf(ParseFailureError);
    expect(truncatedAset.error.failure).toEqual({
      kind: "truncated",
      format: "nro",
      detail: expect.stringContaining("truncated"),
      offset: 0x100,
      field: "asset_header",
      extent: { availableBytes: 8, requiredBytes: 0x38 },
    });
  }
});

it("reads the MOD0 offset at text+4 only from a full text prefix", () => {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(0x1234, 4);
  expect(parseTextMod0Offset(prefix)).toBe(0x1234);
  expect(parseTextMod0Offset(prefix.subarray(0, 7))).toBeNull();
  expect(hasMod0Magic(Buffer.from("MOD0rest"))).toBe(true);
  expect(hasMod0Magic(Buffer.from("MOD"))).toBe(false);
});

it("locates the NRO MOD0 magic only when the file holds it", () => {
  const bytes = buildNro();
  const parsed = parseNroHeader(bytes, bytes.length);
  if (!parsed.ok) throw parsed.error;
  expect(nroMod0MagicExtent(parsed.value, bytes.length)).toEqual({
    offset: 0x80,
    size: 4,
  });
  expect(nroMod0MagicExtent(parsed.value, 0x83)).toBeUndefined();
});
