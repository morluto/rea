import { expect, it } from "vitest";

import { scanZipDirectory } from "./zipDirectory.js";
import { zipArchive, withZip64End } from "./zipArchive.fixture.js";

/** Give a Zip64 end record the extensible data sector APPNOTE 4.3.14 allows. */
const withExtensibleSector = (archive: Buffer, bytes: number): Buffer => {
  const locator = archive.length - 22 - 20;
  const record = locator - 56;
  if (archive.readUInt32LE(record) !== 0x06064b50)
    throw new Error("fixture has no Zip64 end record");
  const widened = Buffer.concat([
    archive.subarray(0, locator),
    Buffer.alloc(bytes, 0xab),
    archive.subarray(locator),
  ]);
  // The record's own length field counts the fixed 44 bytes plus that sector.
  widened.writeBigUInt64LE(BigInt(44 + bytes), record + 4);
  return widened;
};

const directory = (bytes: Buffer) =>
  scanZipDirectory(new Uint8Array(bytes), 10);

it("reads a Zip64 end record that carries an extensible data sector", () => {
  // APPNOTE 4.3.14 lets the record end with a variable-size extensible data
  // sector and 4.3.15 has its locator declare the record's offset, so the
  // record's 56 fixed bytes need not end where the locator begins. Info-ZIP
  // `unzip -l` lists the member of each archive here.
  const plain = zipArchive([{ name: "a.txt", data: Buffer.from("hello") }]);
  expect(directory(plain)?.count).toBe(1);
  expect(directory(withZip64End(plain))?.count).toBe(1);
  for (const bytes of [4, 8, 32, 1024])
    expect(
      directory(withExtensibleSector(withZip64End(plain), bytes))?.count,
      `extensible ${String(bytes)}`,
    ).toBe(1);
});

it("reads that record when data is prepended to the archive", () => {
  // A locator declares an offset into the archive, so prepended data shifts it;
  // the record's own declared length is what still identifies it. Python's
  // `zipfile` searches back over the sector after that declared offset misses,
  // and prepended data is what forces the search instead of the direct read.
  const plain = zipArchive([{ name: "a.txt", data: Buffer.from("hello") }]);
  for (const stub of [0, 16])
    for (const bytes of [0, 8])
      expect(
        directory(
          Buffer.concat([
            Buffer.alloc(stub, 0x99),
            withExtensibleSector(withZip64End(plain), bytes),
          ]),
        )?.count,
        `stub ${String(stub)}, extensible ${String(bytes)}`,
      ).toBe(1);
});

it("searches the whole extensible sector, not the record's fixed bytes with it", () => {
  // The bound is on the sector alone, so the reach is the record's 56 fixed
  // bytes plus that bound. Counting the fixed bytes against it stops the search
  // short and reports a prepended archive as unreadable when its classic record
  // defers to the Zip64 one with sentinel values.
  const plain = zipArchive([{ name: "a.txt", data: Buffer.from("hello") }]);
  const LIMIT = 1 << 20;
  // The record's fixed size, the same 56 bytes the fixture above subtracts.
  for (const bytes of [LIMIT - 56, LIMIT])
    expect(
      directory(
        Buffer.concat([
          Buffer.alloc(16, 0x99),
          withExtensibleSector(withZip64End(plain), bytes),
        ]),
      )?.count,
      `sector ${String(bytes)}`,
    ).toBe(1);
  // One byte past the bound stays outside it, so the search does not grow without limit.
  expect(
    directory(
      Buffer.concat([
        Buffer.alloc(16, 0x99),
        withExtensibleSector(withZip64End(plain), LIMIT + 1),
      ]),
    ),
  ).toBeUndefined();
});
