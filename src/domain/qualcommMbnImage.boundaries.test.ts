import { describe, expect, it } from "vitest";

import {
  mbnElfImage,
  mbnElfWithHashSegment,
  mbnLegacyImage,
} from "./qualcommMbnImage.fixture.js";
import {
  inspectQualcommMbnImage,
  qualcommMbnInventoryCoverage,
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
    expect(qualcommMbnInventoryCoverage(inspection, bytes.length)).toBe(
      "unknown",
    );
  });

  it("keeps a hash count that disagrees with the program headers unknown", () => {
    const bytes = mbnElfImage([
      { type: 0, flags: 0x0700_0000, data: Buffer.alloc(0) },
      { type: 0, flags: HASH_FLAGS, data: hashSegmentData(5) },
      { type: 1, flags: 5, data: Buffer.alloc(16, 1) },
    ]);
    const inspection = inspectQualcommMbnImage(bytes);
    expect(inspection).toMatchObject({
      kind: "elf",
      programHeaderCount: 3,
      facet: { hashSize: 32, hashCount: 5, segmentHashes: [] },
      limitations: ["hash count 5 does not equal the 3 program headers"],
    });
    if (inspection.kind !== "elf") throw new Error("not elf");
    expect(qualcommMbnInventoryCoverage(inspection, bytes.length)).toBe(
      "unknown",
    );
  });
});

describe("hash segment headers cut short", () => {
  // Two program headers; the version 6 hash segment is the last segment.
  const image = mbnElfWithHashSegment({ loads: 0, version: 6 });
  const hashOffset = 128;
  const hashRow = PHOFF + PHENT;

  it("names the segment size when p_filesz ends the header", () => {
    const bytes = patched(image, (copy) =>
      copy.writeUInt32LE(60, hashRow + 16),
    );
    expect(inspectQualcommMbnImage(bytes)).toMatchObject({
      kind: "elf",
      hashSegment: { programHeaderIndex: 1, offset: hashOffset, fileSize: 60 },
      facet: null,
      limitations: [
        "hash segment version 6 needs 80 header bytes; program header 1 declares 60 file bytes",
      ],
    });
  });

  it("names the file end when the file ends the header", () => {
    const bytes = image.subarray(0, hashOffset + 60);
    expect(inspectQualcommMbnImage(bytes)).toMatchObject({
      kind: "elf",
      hashSegment: { programHeaderIndex: 1, offset: hashOffset },
      facet: null,
      limitations: [
        `hash segment version 6 needs 80 header bytes; the ${String(bytes.length)}-byte file ends 60 bytes after offset ${String(hashOffset)}`,
      ],
    });
  });
});
