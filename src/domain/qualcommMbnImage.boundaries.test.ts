import { describe, expect, it } from "vitest";

import {
  mbnElfImage,
  mbnElfWithHashSegment,
  mbnLegacyImage,
} from "./qualcommMbnImage.fixture.js";
import {
  inspectQualcommMbnImage,
  qualcommMbnInventoryCoverage,
  qualcommMbnStoredRegions,
} from "./qualcommMbnImage.js";

const HASH_FLAGS = 0x0220_0000;
const PHOFF = 52;
const PHENT = 32;

const hashSegmentData = (programs: number, version: 3 | 5 | 6 = 3): Buffer =>
  mbnLegacyImage({
    version,
    imageId: 0,
    destination: 0x8810_0028,
    code: Buffer.alloc(programs * 32, 0x11),
    signature: Buffer.alloc(64, 0x5a),
    certificateChain: Buffer.alloc(32, 0xc3),
  });

const patched = (bytes: Buffer, edit: (copy: Buffer) => void): Buffer => {
  const copy = Buffer.from(bytes);
  edit(copy);
  return copy;
};

describe("hostile ELF program header tables", () => {
  const image = mbnElfWithHashSegment({ loads: 1 });

  it("keeps e_phnum 65535 unknown without scanning the table", () => {
    const bytes = patched(image, (copy) => copy.writeUInt16LE(0xffff, 44));
    expect(inspectQualcommMbnImage(bytes)).toEqual({
      kind: "elf",
      elfClass: 32,
      byteOrder: "little",
      machine: 164,
      programHeaderCount: null,
      hashSegment: null,
      furtherHashSegments: null,
      facet: null,
      limitations: [
        "program header count 65535 is the ELF extended numbering sentinel; the hash segment is unknown",
      ],
    });
  });

  it("refuses a program header entry size that is not the class size", () => {
    const bytes = patched(image, (copy) => copy.writeUInt16LE(56, 42));
    expect(inspectQualcommMbnImage(bytes)).toMatchObject({
      kind: "elf",
      hashSegment: null,
      furtherHashSegments: null,
      facet: null,
      limitations: [
        "program header entry size 56 is not the ELF32 size; the hash segment is unknown",
      ],
    });
  });

  it("refuses a program header table that runs past the file end", () => {
    const bytes = patched(image, (copy) =>
      copy.writeUInt32LE(copy.length - PHENT, 28),
    );
    expect(inspectQualcommMbnImage(bytes)).toMatchObject({
      kind: "elf",
      programHeaderCount: 3,
      hashSegment: null,
      furtherHashSegments: null,
      facet: null,
      limitations: [
        `program header table extends past the ${String(bytes.length)}-byte file`,
      ],
    });
  });

  it("reports the first of several hash segments and names the others", () => {
    const bytes = mbnElfImage([
      { type: 0, flags: 0x0700_0000, data: Buffer.alloc(0) },
      { type: 0, flags: HASH_FLAGS, data: hashSegmentData(4) },
      { type: 0, flags: HASH_FLAGS, data: hashSegmentData(4) },
      { type: 1, flags: 5, data: Buffer.alloc(16, 1) },
    ]);
    const inspection = inspectQualcommMbnImage(bytes);
    expect(inspection).toMatchObject({
      kind: "elf",
      hashSegment: { programHeaderIndex: 1 },
      furtherHashSegments: [2],
      facet: { hashCount: 4 },
      limitations: [
        "program header 2 is also a hash segment; REA reports program header 1",
      ],
    });
    if (inspection.kind !== "elf") throw new Error("not elf");
    expect(qualcommMbnInventoryCoverage(inspection)).toBe("unknown");
  });

  it("keeps hash size and count unknown when no candidate matches the program headers", () => {
    const bytes = mbnElfImage([
      { type: 0, flags: 0x0700_0000, data: Buffer.alloc(0) },
      { type: 0, flags: HASH_FLAGS, data: hashSegmentData(5) },
      { type: 1, flags: 5, data: Buffer.alloc(16, 1) },
    ]);
    const inspection = inspectQualcommMbnImage(bytes);
    expect(inspection).toMatchObject({
      kind: "elf",
      programHeaderCount: 3,
      facet: { hashSize: null, hashCount: null, segmentHashes: [] },
      limitations: [
        "code size 160 does not match the 3 program headers (fits 5 32-byte or 8 20-byte hashes); hash size and count are unknown",
      ],
    });
    if (inspection.kind !== "elf") throw new Error("not elf");
    expect(qualcommMbnInventoryCoverage(inspection)).toBe("unknown");
  });

  it("does not guess a digest size for codeSize 192 with 3 program headers", () => {
    const bytes = mbnElfImage([
      { type: 0, flags: 0x0700_0000, data: Buffer.alloc(0) },
      { type: 0, flags: HASH_FLAGS, data: hashSegmentData(6) },
      { type: 1, flags: 5, data: Buffer.alloc(16, 1) },
    ]);
    const inspection = inspectQualcommMbnImage(bytes);
    expect(inspection).toMatchObject({
      kind: "elf",
      programHeaderCount: 3,
      facet: {
        header: { codeSize: 192 },
        hashSize: null,
        hashCount: null,
        segmentHashes: [],
      },
      limitations: [
        "code size 192 does not match the 3 program headers (fits 6 32-byte or 4 48-byte hashes); hash size and count are unknown",
      ],
    });
    if (inspection.kind !== "elf") throw new Error("not elf");
    expect(qualcommMbnInventoryCoverage(inspection)).toBe("unknown");
  });

  it("keeps hash size and count unknown even when only one digest size divides a mismatched codeSize", () => {
    const bytes = mbnElfImage([
      { type: 0, flags: 0x0700_0000, data: Buffer.alloc(0) },
      { type: 0, flags: HASH_FLAGS, data: hashSegmentData(2) },
      { type: 1, flags: 5, data: Buffer.alloc(16, 1) },
    ]);
    const inspection = inspectQualcommMbnImage(bytes);
    expect(inspection).toMatchObject({
      kind: "elf",
      programHeaderCount: 3,
      facet: {
        header: { codeSize: 64 },
        hashSize: null,
        hashCount: null,
        segmentHashes: [],
      },
      limitations: [
        "code size 64 does not match the 3 program headers (fits 2 32-byte hashes); hash size and count are unknown",
      ],
    });
    if (inspection.kind !== "elf") throw new Error("not elf");
    expect(qualcommMbnInventoryCoverage(inspection)).toBe("unknown");
  });
});

describe("hash segment headers cut short", () => {
  // Two program headers; the version 6 hash segment is the last segment.
  const image = mbnElfWithHashSegment({ loads: 0, version: 6 });
  const hashOffset = 128;
  const hashRow = PHOFF + PHENT;

  it("names the segment size when p_filesz ends the header", () => {
    const bytes = patched(image, (copy) =>
      copy.writeUInt32LE(40, hashRow + 16),
    );
    expect(inspectQualcommMbnImage(bytes)).toMatchObject({
      kind: "elf",
      hashSegment: { programHeaderIndex: 1, offset: hashOffset, fileSize: 40 },
      facet: null,
      limitations: [
        "hash segment version 6 needs 48 header bytes; program header 1 declares 40 file bytes",
      ],
    });
  });

  it("names the file end when the file ends the header", () => {
    const bytes = image.subarray(0, hashOffset + 40);
    expect(inspectQualcommMbnImage(bytes)).toMatchObject({
      kind: "elf",
      hashSegment: { programHeaderIndex: 1, offset: hashOffset },
      facet: null,
      limitations: [
        `hash segment version 6 needs 48 header bytes; the ${String(bytes.length)}-byte file ends 40 bytes after offset ${String(hashOffset)}`,
      ],
    });
  });
});

it("bounds v5 payloads by p_filesz even when the bytes are present in the file", () => {
  const image = mbnElfWithHashSegment({ version: 5 });
  const control = inspectQualcommMbnImage(image);
  expect(control).toMatchObject({
    kind: "elf",
    facet: { hashCount: 3 },
    limitations: [],
  });
  const bytes = patched(image, (copy) =>
    copy.writeUInt32LE(40, PHOFF + PHENT + 16),
  );
  const inspection = inspectQualcommMbnImage(bytes);
  expect(inspection).toMatchObject({
    kind: "elf",
    hashSegment: { offset: 160, fileSize: 40 },
    facet: { header: { version: 5, headerBytes: 40 }, segmentHashes: [] },
    limitations: [
      "image range 160+488 exceeds hash segment range 160+40 (p_filesz)",
      "hash table range 200+96 exceeds hash segment range 160+40 (p_filesz)",
      "signature range 296+256 exceeds hash segment range 160+40 (p_filesz)",
      "certificate chain range 552+96 exceeds hash segment range 160+40 (p_filesz)",
    ],
  });
  if (inspection.kind !== "elf") throw new Error("not elf");
  expect(qualcommMbnStoredRegions(inspection)).toEqual([
    { name: "header", range: { offset: 160, length: 40 } },
  ]);
  expect(qualcommMbnInventoryCoverage(inspection)).toBe("unknown");
});

it("reports v6 metadata that crosses the ELF hash segment boundary", () => {
  const data = mbnLegacyImage({
    version: 6,
    code: Buffer.alloc(32),
    signature: Buffer.alloc(0),
    certificateChain: Buffer.alloc(0),
    metadata0: Buffer.alloc(8),
    metadata1: Buffer.alloc(12),
  });
  const image = mbnElfImage([{ type: 0, flags: HASH_FLAGS, data }]);
  const control = inspectQualcommMbnImage(image);
  expect(control).toMatchObject({
    kind: "elf",
    facet: { ranges: { code: { offset: 164, length: 32 } } },
    limitations: [],
  });
  const bytes = patched(image, (copy) => copy.writeUInt32LE(56, PHOFF + 16));
  const inspection = inspectQualcommMbnImage(bytes);
  expect(inspection).toMatchObject({
    kind: "elf",
    facet: { header: { version: 6 }, segmentHashes: [] },
    limitations: [
      "image range 96+100 exceeds hash segment range 96+56 (p_filesz)",
      "metadata 1 range 152+12 exceeds hash segment range 96+56 (p_filesz)",
      "hash table range 164+32 exceeds hash segment range 96+56 (p_filesz)",
    ],
  });
  if (inspection.kind !== "elf") throw new Error("not elf");
  expect(qualcommMbnStoredRegions(inspection)).toEqual([
    { name: "header", range: { offset: 96, length: 48 } },
    { name: "metadata0", range: { offset: 144, length: 8 } },
  ]);
});
