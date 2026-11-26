import { describe, expect, it } from "vitest";

import {
  mbnElfImage,
  mbnElfWithHashSegment,
  mbnLegacyImage,
} from "./qualcommMbnImage.fixture.js";
import { recognizeArtifactFormat } from "./artifactFormatRecognition.js";
import {
  hasQualcommMbnHeader,
  inspectQualcommMbnImage,
  qualcommMbnInventoryCoverage,
} from "./qualcommMbnImage.js";

const LEGACY = mbnLegacyImage({
  code: Buffer.alloc(200, 0xab),
  signature: Buffer.alloc(256, 0x5a),
  certificateChain: Buffer.alloc(96, 0xc3),
});

describe("legacy MBN headers", () => {
  it("reports v3 header fields and file ranges", () => {
    const inspection = inspectQualcommMbnImage(LEGACY);
    expect(inspection).toMatchObject({
      kind: "legacy",
      header: {
        imageId: 21,
        version: 3,
        imageSource: 3,
        imageSourceName: "emmc-user",
        imageSize: 552,
        codeSize: 200,
        signaturePointer: 0x8600_0028 + 200,
        signatureSize: 256,
        certificateChainSize: 96,
        metadata0Size: null,
        headerBytes: 40,
      },
      ranges: {
        header: { offset: 0, length: 40 },
        code: { offset: 40, length: 200 },
        signature: { offset: 240, length: 256 },
        certificateChain: { offset: 496, length: 96 },
        metadata0: null,
      },
      limitations: [],
    });
    if (inspection.kind !== "legacy") throw new Error("not legacy");
    expect(qualcommMbnInventoryCoverage(inspection, LEGACY.length)).toBe(
      "complete",
    );
  });

  it("reports v6 metadata ranges from the 80-byte header", () => {
    const bytes = mbnLegacyImage({
      version: 6,
      code: Buffer.alloc(64, 1),
      signature: Buffer.alloc(32, 2),
      certificateChain: Buffer.alloc(16, 3),
      metadata0: Buffer.alloc(8, 4),
      metadata1: Buffer.alloc(12, 5),
    });
    expect(inspectQualcommMbnImage(bytes)).toMatchObject({
      kind: "legacy",
      header: { version: 6, headerBytes: 80, metadata0Size: 8 },
      ranges: {
        code: { offset: 80, length: 64 },
        metadata0: { offset: 192, length: 8 },
        metadata1: { offset: 200, length: 12 },
      },
    });
  });

  it("reports ranges past the file end as limitations without clamping", () => {
    const truncated = LEGACY.subarray(0, 400);
    const inspection = inspectQualcommMbnImage(truncated);
    expect(inspection).toMatchObject({
      kind: "legacy",
      ranges: { signature: { offset: 240, length: 256 } },
      limitations: [
        "image range 0+552 exceeds the 400-byte file",
        "signature range 240+256 exceeds the 400-byte file",
        "certificate chain range 496+96 exceeds the 400-byte file",
      ],
    });
    if (inspection.kind !== "legacy") throw new Error("not legacy");
    expect(qualcommMbnInventoryCoverage(inspection, truncated.length)).toBe(
      "unknown",
    );
  });

  it("rejects headers whose sizes or pointers disagree", () => {
    const sizes = Buffer.from(LEGACY);
    sizes.writeUInt32LE(9999, 16);
    const pointer = Buffer.from(LEGACY);
    pointer.writeUInt32LE(0x1234, 24);
    const version = Buffer.from(LEGACY);
    version.writeUInt32LE(4, 4);
    for (const bytes of [sizes, pointer, version, Buffer.alloc(64)])
      expect(hasQualcommMbnHeader(bytes)).toBe(false);
  });

  it("does not claim a header whose code region is not in the file", () => {
    // 40 header bytes alone, then the header and 199 of 200 code bytes.
    for (const length of [40, 239]) {
      const bytes = LEGACY.subarray(0, length);
      expect(hasQualcommMbnHeader(bytes)).toBe(false);
      expect(
        recognizeArtifactFormat({
          prefix: bytes,
          fileSize: bytes.length,
          espFlashLayout: false,
        }),
      ).toBeUndefined();
    }
    expect(hasQualcommMbnHeader(LEGACY.subarray(0, 240))).toBe(true);
  });

  it("is recognized only after signature formats, and ELF stays ELF", () => {
    expect(
      recognizeArtifactFormat({
        prefix: LEGACY,
        fileSize: LEGACY.length,
        espFlashLayout: false,
      }),
    ).toMatchObject({ state: "recognized", format: "qualcomm-mbn" });
    const elf = mbnElfWithHashSegment();
    expect(hasQualcommMbnHeader(elf)).toBe(false);
    expect(
      recognizeArtifactFormat({
        prefix: elf,
        fileSize: elf.length,
        espFlashLayout: false,
      }),
    ).toBeUndefined();
  });
});

describe("ELF MBN hash segments", () => {
  it("decodes the hash segment header and per-program-header hashes", () => {
    const bytes = mbnElfWithHashSegment({ loads: 2 });
    const inspection = inspectQualcommMbnImage(bytes);
    expect(inspection).toMatchObject({
      kind: "elf",
      elfClass: 32,
      byteOrder: "little",
      machine: 164,
      programHeaderCount: 4,
      hashSegment: { programHeaderIndex: 1, offset: 192 },
      furtherHashSegments: [],
      facet: {
        header: { version: 3, codeSize: 128, signatureSize: 256 },
        ranges: {
          header: { offset: 192, length: 40 },
          code: { offset: 232, length: 128 },
          signature: { offset: 360, length: 256 },
          certificateChain: { offset: 616, length: 96 },
        },
        hashSize: 32,
        hashCount: 4,
      },
      limitations: [],
    });
    if (inspection.kind !== "elf" || inspection.facet === null)
      throw new Error("no facet");
    expect(
      inspection.facet.segmentHashes.map((hash) => [
        hash.programHeaderIndex,
        hash.segmentType,
        hash.hashOffset,
      ]),
    ).toEqual([
      [0, 7, 232],
      [1, 2, 264],
      [2, 0, 296],
      [3, 0, 328],
    ]);
    expect(qualcommMbnInventoryCoverage(inspection, bytes.length)).toBe(
      "complete",
    );
  });

  it("reports an ELF without a hash segment as having no MBN facet", () => {
    const bytes = mbnElfImage([
      { type: 1, flags: 5, data: Buffer.alloc(32, 1) },
    ]);
    expect(inspectQualcommMbnImage(bytes)).toMatchObject({
      kind: "elf",
      programHeaderCount: 1,
      hashSegment: null,
      furtherHashSegments: [],
      facet: null,
      limitations: [],
    });
  });

  it("keeps a hash-segment signature past the file end as a limitation", () => {
    const bytes = mbnElfWithHashSegment({ loads: 1 });
    const truncated = bytes.subarray(0, 400);
    const inspection = inspectQualcommMbnImage(truncated);
    expect(inspection).toMatchObject({
      kind: "elf",
      facet: { ranges: { signature: { offset: 296, length: 256 } } },
    });
    if (inspection.kind !== "elf") throw new Error("not elf");
    expect(inspection.limitations).toContain(
      "signature range 296+256 exceeds the 400-byte file",
    );
    expect(qualcommMbnInventoryCoverage(inspection, truncated.length)).toBe(
      "unknown",
    );
  });

  it("reports a hash segment that is not an MBN header", () => {
    const bytes = mbnElfImage([
      { type: 0, flags: 0x0220_0000, data: Buffer.alloc(64, 0xff) },
    ]);
    expect(inspectQualcommMbnImage(bytes)).toMatchObject({
      kind: "elf",
      hashSegment: { programHeaderIndex: 0 },
      facet: null,
      limitations: ["hash segment program header 0 is not an MBN header"],
    });
  });
});
