import { expect, it } from "vitest";
import {
  elfArchitecture,
  readElfFixedHeader,
  readElfHeaderFacts,
} from "./elfFixedHeader.js";
import { elf } from "./binaryTarget.fixture.js";

it.each([
  ["ELF32 little endian", 1, 1],
  ["ELF32 big endian", 1, 2],
  ["ELF64 little endian", 2, 1],
  ["ELF64 big endian", 2, 2],
] as const)(
  "admits common fields and preserves invalid raw declarations for %s",
  (_name, cls, data) => {
    const machine = cls === 1 ? 3 : 62;
    const bytes = Buffer.concat([
      Buffer.alloc(7, 0xa5),
      elf(cls, data, machine),
    ]).subarray(7);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const littleEndian = data === 1;
    const headerSizeAt = cls === 1 ? 40 : 52;
    view.setUint16(16, 0xfe01, littleEndian);
    view.setUint32(cls === 1 ? 36 : 48, 0x89abcdef, littleEndian);
    bytes[7] = 6;
    bytes[8] = 7;
    const common = {
      elfClass: cls === 1 ? 32 : 64,
      byteOrder: littleEndian ? "little" : "big",
      type: 0xfe01,
      flags: 0x89abcdef,
      osAbi: 6,
    };
    expect(readElfFixedHeader(bytes)).toEqual({
      ok: true,
      value: {
        ...common,
        headerSize: cls === 1 ? 52 : 64,
        machine,
        abiVersion: 7,
        architecture: cls === 1 ? "x86" : "x86_64",
      },
    });

    // Reading the raw fields preserves them even when general admission refuses the image.
    view.setUint16(18, 0xfffe, littleEndian);
    view.setUint32(20, 0x89abcdef, littleEndian);
    view.setUint16(headerSizeAt, 0, littleEndian);
    bytes[8] = 0xff;
    expect(readElfHeaderFacts(bytes)).toEqual({
      ok: true,
      value: {
        ...common,
        machine: 0xfffe,
        version: 0x89abcdef,
        abiVersion: 0xff,
        headerSize: 0,
      },
    });
    expect(readElfFixedHeader(bytes)).toEqual({
      ok: false,
      error: "unsupported ELF header version",
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

it("classifies EM_PPC64 only for a caller that commits ELF64", () => {
  expect(elfArchitecture(21, 64)).toBe("powerpc");
  expect(elfArchitecture(21, 32)).toBeUndefined();
  // Readers that pass only the machine keep their reports as they were.
  expect(elfArchitecture(21)).toBeUndefined();
  expect(elfArchitecture(20)).toBe("powerpc");
});

it("preserves an unknown ELF machine as a fact without rejecting the header", () => {
  expect(readElfFixedHeader(elf(2, 2, 0xfffe))).toMatchObject({
    ok: true,
    value: { machine: 0xfffe, architecture: null, osAbi: 0, abiVersion: 0 },
  });
});

it("accepts NVIDIA's vendor ELF version only for the CUDA machine and OS ABI", () => {
  const bytes = elf(2, 1, 190);
  bytes.writeUInt32LE(0x81, 20);
  expect(readElfFixedHeader(bytes).ok).toBe(false);
  bytes[7] = 0x33;
  expect(readElfFixedHeader(bytes)).toMatchObject({
    ok: true,
    value: { machine: 190 },
  });
  bytes.writeUInt16LE(62, 18);
  expect(readElfFixedHeader(bytes).ok).toBe(false);
});

it("keeps framing failures ahead of version and declared-size admission", () => {
  const bytes = elf(2, 1, 62);
  bytes[6] = 0;
  bytes.writeUInt32LE(0, 20);
  bytes.writeUInt16LE(0, 52);
  expect(readElfFixedHeader(bytes.subarray(0, 16), 16)).toEqual({
    ok: false,
    error: "unsupported ELF identification version",
  });
  bytes[6] = 1;
  const truncated = readElfFixedHeader(bytes, 63);
  expect(truncated).toMatchObject({
    ok: false,
    error: expect.stringContaining("truncated ELF header"),
  });
  expect(readElfFixedHeader(bytes)).toEqual({
    ok: false,
    error: "unsupported ELF header version",
  });
  bytes.writeUInt32LE(1, 20);
  expect(readElfFixedHeader(bytes)).toEqual({
    ok: false,
    error: "invalid ELF header size",
  });
});
