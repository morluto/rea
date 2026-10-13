import { expect, it } from "vitest";
import { readElfFixedHeader } from "./elfFixedHeader.js";
import { elf } from "./binaryTarget.fixture.js";

it.each([
  ["ELF32 little endian", 1, 1],
  ["ELF32 big endian", 1, 2],
  ["ELF64 little endian", 2, 1],
  ["ELF64 big endian", 2, 2],
] as const)(
  "reads common fixed header commitments for %s",
  (_name, cls, data) => {
    const bytes = elf(cls, data, cls === 1 ? 3 : 62);
    expect(readElfFixedHeader(bytes)).toEqual({
      ok: true,
      value: {
        elfClass: cls === 1 ? 32 : 64,
        byteOrder: data === 1 ? "little" : "big",
        headerSize: cls === 1 ? 52 : 64,
      },
    });
  },
);

it.each([
  [
    "identification version",
    (bytes: Buffer) => {
      bytes[6] = 0;
    },
  ],
  [
    "header version",
    (bytes: Buffer) => {
      bytes.writeUInt32LE(0, 20);
    },
  ],
  [
    "undersized declared header",
    (bytes: Buffer) => {
      bytes.writeUInt16LE(51, 40);
    },
  ],
  [
    "declared header beyond file",
    (bytes: Buffer) => {
      bytes.writeUInt16LE(53, 40);
    },
  ],
])("rejects an invalid %s", (_name, corrupt) => {
  const bytes = elf(1, 1, 3);
  corrupt(bytes);
  expect(readElfFixedHeader(bytes)).toMatchObject({ ok: false });
});

it("checks declared header size against the whole file, not the prefix", () => {
  const bytes = elf(2, 1, 62);
  bytes.writeUInt16LE(128, 52);
  expect(readElfFixedHeader(bytes, 128)).toMatchObject({ ok: true });
  expect(readElfFixedHeader(bytes, 127)).toMatchObject({ ok: false });
});
