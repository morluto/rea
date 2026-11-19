import { Buffer } from "node:buffer";
import { expect, it } from "vitest";

import { buildFfsFile } from "../../tests/fixtures/uefiImage.js";
import { imageRegion } from "./UefiBytes.js";
import {
  readFfsHeader,
  parseFfsFileHeader,
  verifyFfsFileChecksum,
} from "./FfsFile.js";

it("parses a valid FFS2 driver file header", () => {
  const file = buildFfsFile({
    guid: "17111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: Buffer.from("payload-bytes"),
  });
  const region = imageRegion(file, 0, file.length);
  const header = parseFfsFileHeader(region, 0, true);
  expect(header).not.toBeNull();
  expect(header?.nameGuid).toBe("17111111-2222-3333-4444-555555555555");
  expect(header?.typeCode).toBe(0x07);
  expect(header?.headerLength).toBe(24);
  expect(header?.declaredLength).toBe(24 + 13);
  expect(header?.headerChecksumValid).toBe(true);
  expect(header?.fileChecksumRequired).toBe(false);
  expect(header?.rawState).toBe(0x38);
  expect(header?.normalizedState).toBe(0x07);
  expect(header?.stateFlags).toEqual([
    "header-construction",
    "header-valid",
    "data-valid",
  ]);
});

it("flags a deliberately broken header checksum", () => {
  const file = buildFfsFile({
    guid: "18111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: Buffer.from("x"),
    breakHeaderChecksum: true,
  });
  const region = imageRegion(file, 0, file.length);
  expect(parseFfsFileHeader(region, 0, true)?.headerChecksumValid).toBe(false);
});

it("normalizes state bits under both erase polarities", () => {
  const file = buildFfsFile({
    guid: "19111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: Buffer.from("y"),
    erasePolarity: false,
  });
  const region = imageRegion(file, 0, file.length);
  const header = parseFfsFileHeader(region, 0, false);
  expect(header?.rawState).toBe(0x07);
  expect(header?.normalizedState).toBe(0x07);
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
    const valid = verifyFfsFileChecksum(
      region.buffer,
      (header?.localBase ?? 0) + (header?.headerLength ?? 0),
      payload.length,
      header?.fileChecksumField ?? -1,
    );
    expect(valid).toBe(image === correct);
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
  expect(readFfsHeader(eraseRegion, 0, true)).toEqual({ kind: "end" });
  expect(readFfsHeader(eraseRegion, 0, false)).toMatchObject({
    kind: "unparsed",
  });
  const zeroRegion = imageRegion(Buffer.alloc(64, 0x00), 0, 64);
  expect(readFfsHeader(zeroRegion, 0, false)).toEqual({ kind: "end" });
});
