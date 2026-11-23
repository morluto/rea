import { expect, it } from "vitest";
import {
  inspectPeCodeViewFromBuffer,
  inspectPeCodeViewFromReader,
  peCodeViewDirectoryEntries,
} from "./binaryTarget.js";
import { pe } from "./binaryTarget.fixture.js";

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

it("finds a CodeView record beyond the first directory read", async () => {
  const peOffset = 64;
  const optionalHeader = peOffset + 24;
  const sectionHeader = optionalHeader + 240;
  const directory = 512;
  const firstRead = 1024 * 28;
  const directorySize = firstRead + 28;
  const payloadOffset = directory + directorySize;
  const original = pe(0x8664, peOffset, 0x0002, false, { pdbPath: "app.pdb" });
  const image = Buffer.alloc(payloadOffset + original.length - directory - 28);
  original.copy(image, 0, 0, directory);
  original.copy(image, directory + firstRead, directory);
  image.writeUInt32LE(directorySize, optionalHeader + 112 + 6 * 8 + 4);
  image.writeUInt32LE(directorySize, sectionHeader + 8);
  image.writeUInt32LE(directorySize, sectionHeader + 16);
  image.writeUInt32LE(payloadOffset, directory + firstRead + 24);
  const reads: Array<{ offset: number; length: number }> = [];
  const inspect = (bytes: Buffer) =>
    inspectPeCodeViewFromReader(
      {
        size: bytes.length,
        readRange: async (offset, length) => {
          reads.push({ offset, length });
          return bytes.subarray(offset, offset + length);
        },
      },
      peOffset,
    );

  const expected = inspectPeCodeViewFromBuffer(original, peOffset);
  expect(expected).toMatchObject({ ok: true, value: { pdbPath: "app.pdb" } });
  expect(inspectPeCodeViewFromBuffer(image, peOffset)).toEqual(expected);
  expect(await inspect(image)).toEqual(expected);
  expect(
    reads.filter(({ offset }) => offset >= directory && offset < payloadOffset),
  ).toEqual([
    { offset: directory, length: firstRead },
    { offset: directory + firstRead, length: 28 },
  ]);

  reads.length = 0;
  const truncated = image.subarray(0, payloadOffset - 1);
  const incomplete = inspectPeCodeViewFromBuffer(truncated, peOffset);
  expect(incomplete).toMatchObject({
    ok: false,
    error: { kind: "incomplete" },
  });
  expect(await inspect(truncated)).toEqual(incomplete);
  expect(reads.every(({ offset }) => offset < directory)).toBe(true);
});
