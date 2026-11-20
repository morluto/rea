import { Buffer } from "node:buffer";
import { expect, it } from "vitest";

import { buildFfsFile } from "../../tests/fixtures/uefiImage.js";
import { imageRegion } from "./UefiBytes.js";
import {
  readFfsHeader,
  parseFfsFileHeader,
  checkFfsFileIntegrity,
} from "./FfsFile.js";

it("observes the FFS2 driver header under either erase polarity and detects checksum corruption", () => {
  const file = buildFfsFile({
    guid: "17111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: Buffer.from("payload-bytes"),
  });
  const region = imageRegion(file, 0, file.length);
  const stateFlags = ["header-construction", "header-valid", "data-valid"];
  expect(parseFfsFileHeader(region, 0, true)).toMatchObject({
    nameGuid: "17111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    headerLength: 24,
    declaredLength: 37,
    headerChecksumValid: true,
    fileChecksumRequired: false,
    rawState: 0x38,
    stateFlags,
  });

  file[23] = 0x07; // The state byte is independent of the header checksum.
  expect(parseFfsFileHeader(region, 0, false)).toMatchObject({
    rawState: 0x07,
    stateFlags,
    headerChecksumValid: true,
  });

  file[16] = file.readUInt8(16) ^ 1;
  expect(parseFfsFileHeader(region, 0, false)).toMatchObject({
    rawState: 0x07,
    headerChecksumValid: false,
  });
});

it("verifies the optional file-data checksum", () => {
  const payload = Buffer.from("checksummed payload");
  const correct = buildFfsFile({
    guid: "1a111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload,
    fileChecksum: "correct",
  });
  const wrong = buildFfsFile({
    guid: "1b111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload,
    fileChecksum: "wrong",
  });
  for (const image of [correct, wrong]) {
    const region = imageRegion(image, 0, image.length);
    const header = parseFfsFileHeader(region, 0, true);
    expect(header?.fileChecksumRequired).toBe(true);
    if (header === null) throw new Error("Missing FFS header");
    expect(checkFfsFileIntegrity(region, header).verdict).toBe(
      image === correct ? "valid" : "invalid",
    );
  }
});

it.each([
  [0, 1],
  [1, 16],
  [2, 128],
  [7, 65536],
])("decodes PI alignment index %i as %i bytes", (index, alignment) => {
  const image = buildFfsFile({
    guid: "19111111-2222-3333-4444-555555555555",
    typeCode: 0x01,
    payload: Buffer.from("body"),
    alignmentExponent: index,
  });
  expect(
    parseFfsFileHeader(imageRegion(image, 0, image.length), 0, true)
      ?.dataAlignment,
  ).toBe(alignment);
});

it("recognizes erased header windows per polarity", () => {
  const eraseRegion = imageRegion(Buffer.alloc(64, 0xff), 0, 64);
  expect(
    readFfsHeader(eraseRegion, 0, { erasePolarity: true, fileSystem: "ffs3" }),
  ).toEqual({ kind: "end" });
  expect(
    readFfsHeader(eraseRegion, 0, { erasePolarity: false, fileSystem: "ffs3" }),
  ).toMatchObject({
    kind: "unparsed",
  });
  const zeroRegion = imageRegion(Buffer.alloc(64, 0x00), 0, 64);
  expect(
    readFfsHeader(zeroRegion, 0, { erasePolarity: false, fileSystem: "ffs3" }),
  ).toEqual({ kind: "end" });
  expect(
    readFfsHeader(zeroRegion, 0, { erasePolarity: true, fileSystem: "ffs3" }),
  ).toMatchObject({
    kind: "unparsed",
  });
});

it.each([0x01, 0x20])(
  "continues after a bounded FFS3 header with state bit %i and an unrepresentable size",
  (state) => {
    const unusable = Buffer.alloc(32, 0xff);
    unusable[19] = 1;
    unusable[23] = ~state & 0x3f;
    const sibling = buildFfsFile({
      guid: "19111111-2222-3333-4444-555555555555",
      typeCode: 0x01,
      payload: Buffer.from("body"),
    });
    const bytes = Buffer.concat([Buffer.alloc(8, 0xff), unusable, sibling]);
    const region = imageRegion(bytes, 8, bytes.length);
    const result = readFfsHeader(region, 8, {
      erasePolarity: true,
      fileSystem: "ffs3",
    });
    expect(result).toMatchObject({
      kind: "unusable-header",
      offset: 8,
      length: 32,
      nextLocal: 40,
      detail: expect.stringContaining("0xffffffffffffffff"),
    });
    if (result.kind !== "unusable-header")
      throw new Error("Expected a bounded unusable header");
    expect(
      readFfsHeader(region, result.nextLocal, {
        erasePolarity: true,
        fileSystem: "ffs3",
      }),
    ).toMatchObject({
      kind: "file",
      header: { localBase: 40, declaredLength: 28 },
    });
  },
);

it("does not infer a fixed-header skip for a data-valid FFS3 declaration", () => {
  const file = Buffer.alloc(40, 0xff);
  file[19] = 1;
  file[23] = 0x38;
  expect(
    readFfsHeader(imageRegion(file, 0, file.length), 0, {
      erasePolarity: true,
      fileSystem: "ffs3",
    }),
  ).toMatchObject({
    kind: "unparsed",
    offset: 0,
    length: 40,
  });
});

it("retains the header-valid FFS extent without validating unwritten data", () => {
  const file = buildFfsFile({
    guid: "19111111-2222-3333-4444-555555555555",
    typeCode: 0x01,
    payload: Buffer.alloc(8, 0xff),
    fileChecksum: "correct",
  });
  file[23] = ~0x03 & 0x3f;
  const region = imageRegion(file, 0, file.length);
  const result = readFfsHeader(region, 0, {
    erasePolarity: true,
    fileSystem: "ffs3",
  });
  expect(result).toMatchObject({
    kind: "file",
    nextLocal: 32,
    header: {
      headerChecksumValid: true,
      extentIssue: null,
      body: { start: 24, end: 32 },
      bodyIssue: "data-not-valid",
    },
  });
  if (result.kind !== "file") throw new Error("Expected a bounded file");
  expect(checkFfsFileIntegrity(region, result.header)).toEqual({
    verdict: "unchecked",
  });
});

it.each([true, false])(
  "keeps non-erased bytes with an unset FFS state unparsed (erase polarity %s)",
  (erasePolarity) => {
    const file = buildFfsFile({
      guid: "19111111-2222-3333-4444-555555555555",
      typeCode: 0x01,
      payload: Buffer.from("not committed"),
      erasePolarity,
    });
    file[23] = erasePolarity ? 0xff : 0;
    expect(
      readFfsHeader(imageRegion(file, 0, file.length), 0, {
        erasePolarity: erasePolarity,
        fileSystem: "ffs3",
      }),
    ).toMatchObject({
      kind: "unparsed",
      offset: 0,
      length: file.length,
      detail: expect.stringContaining("no recognized state bits"),
    });
  },
);
