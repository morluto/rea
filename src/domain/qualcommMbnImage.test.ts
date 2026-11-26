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
  qualcommMbnStoredRegions,
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
        headerBytes: 80,
      },
      ranges: {
        header: { offset: 0, length: 80 },
        code: { offset: 80, length: 200 },
        signature: { offset: 280, length: 256 },
        certificateChain: { offset: 536, length: 96 },
        metadata0: null,
      },
      limitations: [],
    });
    if (inspection.kind !== "legacy") throw new Error("not legacy");
    expect(qualcommMbnInventoryCoverage(inspection)).toBe("complete");
  });

  it("reports ranges past the file end as limitations without clamping", () => {
    const truncated = LEGACY.subarray(0, 400);
    const inspection = inspectQualcommMbnImage(truncated);
    expect(inspection).toMatchObject({
      kind: "legacy",
      ranges: { signature: { offset: 280, length: 256 } },
      limitations: [
        "image range 0+632 exceeds the 400-byte file",
        "signature range 280+256 exceeds the 400-byte file",
        "certificate chain range 536+96 exceeds the 400-byte file",
      ],
    });
    if (inspection.kind !== "legacy") throw new Error("not legacy");
    expect(qualcommMbnInventoryCoverage(inspection)).toBe("unknown");
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

  it("rejects an image size that also counts the header", () => {
    const withHeader = Buffer.from(LEGACY);
    withHeader.writeUInt32LE(552 + 80, 16);
    expect(hasQualcommMbnHeader(withHeader)).toBe(false);
    expect(inspectQualcommMbnImage(withHeader).kind).toBe("unrecognized");
  });

  it("does not claim a header whose code region is not in the file", () => {
    // 80 header bytes alone, then the header and 199 of 200 code bytes.
    for (const length of [80, 279]) {
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
    expect(hasQualcommMbnHeader(LEGACY.subarray(0, 280))).toBe(true);
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

describe("MBN v5 and v6 headers", () => {
  it.each([
    {
      version: 5,
      headerBytes: 40,
      metadataBytes: 0,
      codeOffset: 40,
      imageSize: 132,
    },
    {
      version: 6,
      headerBytes: 48,
      metadataBytes: 20,
      codeOffset: 68,
      imageSize: 152,
    },
  ] as const)(
    "decodes v$version payload order and size fields",
    ({ version, headerBytes, metadataBytes, codeOffset, imageSize }) => {
      const bytes = mbnLegacyImage({
        version,
        code: Buffer.alloc(64, 1),
        signature: Buffer.alloc(32, 2),
        certificateChain: Buffer.alloc(16, 3),
        metadata0: Buffer.alloc(version === 6 ? 8 : 0, 4),
        metadata1: Buffer.alloc(version === 6 ? 12 : 0, 5),
        qtiSignature: Buffer.alloc(7, 6),
        qtiCertificateChain: Buffer.alloc(13, 7),
      });
      expect(inspectQualcommMbnImage(bytes)).toMatchObject({
        kind: "legacy",
        header: {
          version,
          headerBytes,
          imageSize,
          imageSource: null,
          imageDestination: null,
          qtiSignatureSize: 7,
          qtiCertificateChainSize: 13,
          signaturePointer: 0xffff_ffff,
          certificateChainPointer: 0xffff_ffff,
          metadata0Size: version === 6 ? 8 : null,
          metadata1Size: version === 6 ? 12 : null,
        },
        ranges: {
          header: { offset: 0, length: headerBytes },
          metadata0: version === 6 ? { offset: 48, length: 8 } : null,
          metadata1: version === 6 ? { offset: 56, length: 12 } : null,
          code: { offset: codeOffset, length: 64 },
          qtiSignature: { offset: codeOffset + 64, length: 7 },
          qtiCertificateChain: { offset: codeOffset + 71, length: 13 },
          signature: { offset: codeOffset + 84, length: 32 },
          certificateChain: { offset: codeOffset + 116, length: 16 },
        },
        limitations: [],
      });
      expect(bytes[headerBytes + metadataBytes]).toBe(1);
      bytes.writeUInt32LE(imageSize - 7, 16);
      expect(inspectQualcommMbnImage(bytes).kind).toBe("unrecognized");
    },
  );
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
          header: { offset: 192, length: 80 },
          code: { offset: 272, length: 128 },
          signature: { offset: 400, length: 256 },
          certificateChain: { offset: 656, length: 96 },
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
      [0, 7, 272],
      [1, 2, 304],
      [2, 0, 336],
      [3, 0, 368],
    ]);
    expect(qualcommMbnInventoryCoverage(inspection)).toBe("complete");
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
      facet: { ranges: { signature: { offset: 336, length: 256 } } },
    });
    if (inspection.kind !== "elf") throw new Error("not elf");
    expect(inspection.limitations).toContain(
      "signature range 336+256 exceeds the 400-byte file",
    );
    expect(qualcommMbnInventoryCoverage(inspection)).toBe("unknown");
  });

  it("keeps a readable hash-segment header when its hash table runs past EOF", () => {
    const bytes = mbnElfWithHashSegment({ loads: 1 });
    // Hash segment starts at 160: 80-byte header (160..240) and 96-byte hash table (240..336).
    for (const length of [240, 280]) {
      const truncated = bytes.subarray(0, length);
      const inspection = inspectQualcommMbnImage(truncated);
      expect(inspection).toMatchObject({
        kind: "elf",
        hashSegment: { programHeaderIndex: 1, offset: 160 },
        facet: {
          header: {
            version: 3,
            headerBytes: 80,
            codeSize: 96,
            signatureSize: 256,
            certificateChainSize: 96,
          },
          ranges: {
            header: { offset: 160, length: 80 },
            code: { offset: 240, length: 96 },
            signature: { offset: 336, length: 256 },
            certificateChain: { offset: 592, length: 96 },
          },
          hashSize: 32,
          hashCount: 3,
        },
      });
      if (inspection.kind !== "elf" || inspection.facet === null)
        throw new Error("expected decoded ELF facet");
      expect(inspection.limitations).toContain(
        `hash table range 240+96 exceeds the ${String(length)}-byte file`,
      );
      expect(
        inspection.limitations.some((message) =>
          message.includes("not an MBN header"),
        ),
      ).toBe(false);
      expect(qualcommMbnStoredRegions(inspection)).toEqual([
        { name: "header", range: { offset: 160, length: 80 } },
      ]);
      expect(qualcommMbnInventoryCoverage(inspection)).toBe("unknown");
    }
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
