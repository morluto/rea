import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { locateTrailingZipArchive } from "./zipPackageFormat.js";

it("requires the first local ZIP header and its variable fields to fit before the directory", async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("a.txt", new TextReader("hello"));
  const zip = Buffer.from(await writer.close());
  const prefix = Buffer.from("#!/bin/sh\nexit 0\n");
  const directory = zip.readUInt32LE(zip.length - 22 + 16);
  const locate = async (archive: Buffer) => {
    const file = Buffer.concat([prefix, archive]);
    return locateTrailingZipArchive(file.length, async (start, length) =>
      file.subarray(start, start + length),
    );
  };

  const overlappingFixedHeader = Buffer.from(zip);
  overlappingFixedHeader.writeUInt32LE(0x04034b50, directory - 4);
  overlappingFixedHeader.writeUInt32LE(directory - 4, directory + 42);
  const overlappingExtraField = Buffer.from(zip);
  overlappingExtraField.writeUInt16LE(directory, 28);

  expect(await locate(zip)).toEqual({ leadingBytes: prefix.length });
  expect(await locate(overlappingFixedHeader)).toBeUndefined();
  expect(await locate(overlappingExtraField)).toBeUndefined();
});
