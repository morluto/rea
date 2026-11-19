import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { hasTrailingZipArchive } from "./zipPackageFormat.js";

it("requires the first trailing ZIP directory record and its local header to fit their regions", async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("a.txt", new TextReader("hello"));
  const zip = Buffer.from(await writer.close());
  const prefix = Buffer.from("#!/bin/sh\nexit 0\n");
  const directoryBytes = zip.readUInt32LE(zip.length - 22 + 12);
  const directory = zip.readUInt32LE(zip.length - 22 + 16);
  const probe = async (archive: Buffer) => {
    const file = Buffer.concat([prefix, archive]);
    return hasTrailingZipArchive(file.length, async (start, length) =>
      file.subarray(start, start + length),
    );
  };

  const overlappingFixedHeader = Buffer.from(zip);
  overlappingFixedHeader.writeUInt32LE(0x04034b50, directory - 4);
  overlappingFixedHeader.writeUInt32LE(directory - 4, directory + 42);
  const overlappingExtraField = Buffer.from(zip);
  overlappingExtraField.writeUInt16LE(directory, 28);
  const overlappingComment = Buffer.from(zip);
  overlappingComment.writeUInt16LE(directoryBytes, directory + 32);

  expect(await probe(zip)).toBe(true);
  expect(await probe(overlappingFixedHeader)).toBe(false);
  expect(await probe(overlappingExtraField)).toBe(false);
  expect(await probe(overlappingComment)).toBe(false);
});
