import { expect, it } from "vitest";
import { peCodeViewDirectoryEntries } from "./binaryTarget.js";

const entry = (type: number, size: number, rva: number, raw: number) => {
  const bytes = Buffer.alloc(28);
  bytes.writeUInt32LE(type, 12);
  bytes.writeUInt32LE(size, 16);
  bytes.writeUInt32LE(rva, 20);
  bytes.writeUInt32LE(raw, 24);
  return bytes;
};

const section = () => {
  const bytes = Buffer.alloc(40);
  bytes.writeUInt32LE(0x2000, 12);
  bytes.writeUInt32LE(4096, 16);
  bytes.writeUInt32LE(0x400, 20);
  return bytes;
};

it("prefers physical pointers and maps only missing pointers through section or header RVAs", () => {
  const directory = Buffer.concat([
    entry(2, 32, 0x2000, 0x900),
    entry(2, 32, 0x2020, 0),
    entry(2, 32, 0x100, 0),
    entry(2, 32, 0x8000, 0),
  ]);
  expect([
    ...peCodeViewDirectoryEntries(directory, section(), 1, 0x400),
  ]).toEqual([
    { fileOffset: 0x900, declaredSize: 32 },
    { fileOffset: 0x420, declaredSize: 32 },
    { fileOffset: 0x100, declaredSize: 32 },
    { fileOffset: undefined, declaredSize: 32 },
  ]);
});

it("retains an undersized CodeView declaration and skips other types and partial entries", () => {
  const directory = Buffer.concat([
    entry(1, 32, 0, 0x500),
    entry(2, 15, 0, 0x600),
    entry(2, 16, 0, 0x700),
    entry(2, 32, 0, 0x800).subarray(0, 27),
  ]);
  expect([
    ...peCodeViewDirectoryEntries(directory, Buffer.alloc(0), 0, 0),
  ]).toEqual([
    { fileOffset: undefined, declaredSize: 15 },
    { fileOffset: 0x700, declaredSize: 16 },
  ]);
});

it("maps the bounded payload prefix while retaining its full declared size", () => {
  const directory = Buffer.concat([
    entry(2, 8192, 0x2000, 0),
    entry(2, 8192, 0x2001, 0),
  ]);
  expect([
    ...peCodeViewDirectoryEntries(directory, section(), 1, 0x400),
  ]).toEqual([
    { fileOffset: 0x400, declaredSize: 8192 },
    { fileOffset: undefined, declaredSize: 8192 },
  ]);
});
