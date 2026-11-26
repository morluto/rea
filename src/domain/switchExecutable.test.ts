import { expect, it } from "vitest";

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
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
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
  expect(parseNsoHeader(buildNso().subarray(0, 0x80), 0x80)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("truncated") },
  });
  const overlap = buildNso();
  overlap.writeUInt32LE(0x20, 0x10);
  expect(parseNsoHeader(overlap, overlap.length)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("overlaps the header") },
  });
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
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
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
  expect(parseNroHeader(bytes, bytes.length)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("past the declared image size") },
  });
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
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(nroMod0MagicExtent(parsed.value, bytes.length)).toEqual({
    offset: 0x80,
    size: 4,
  });
  expect(nroMod0MagicExtent(parsed.value, 0x83)).toBeUndefined();
});
