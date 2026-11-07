import { expect, it } from "vitest";
import { hasMachoMagic, readMachoHeaderPrefixFacts } from "./machoContainer.js";
import {
  claimsExecutableHeader,
  parseExecutableHeader,
} from "../binaryTarget.js";
import {
  decodeMachoFixedWordFields,
  readMachoHeaderDeclarations,
  readMachoLinkeditDataCommand,
  readMachoLoadCommandDeclarations,
  readMachoLoadCommandTableHeader,
  readMachoSymtabCommand,
} from "./machoLoadCommands.js";

it.each([
  { magic: 0xfeedface, wide: false, littleEndian: false },
  { magic: 0xcefaedfe, wide: false, littleEndian: true },
  { magic: 0xfeedfacf, wide: true, littleEndian: false },
  { magic: 0xcffaedfe, wide: true, littleEndian: true },
])(
  "separates common header observations from full header and table admission ($magic)",
  ({ magic, wide, littleEndian }) => {
    const backing = Buffer.alloc(43, 0xa5);
    const bytes = backing.subarray(7, 35);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(0, magic, false);
    view.setUint32(4, 0xfedcba98, littleEndian);
    view.setUint32(8, 0x89abcdef, littleEndian);
    view.setUint32(12, 0xffffffff, littleEndian);
    view.setUint32(16, 0x80000001, littleEndian);
    view.setUint32(20, 0xffffffff, littleEndian);
    view.setUint32(24, 0x01200085, littleEndian);
    const expected = {
      headerSize: wide ? 32 : 28,
      wide,
      littleEndian,
      commandCount: 0x80000001,
      commandBytes: 0xffffffff,
      fileType: 0xffffffff,
      flags: 0x01200085,
      identity: { cpuType: 0xfedcba98, cpuSubtype: 0x89abcdef },
    };
    const format = { wide, littleEndian, headerSize: wide ? 32 : 28 };
    for (const length of [0, 3, 4, 11, 12]) {
      const prefix = bytes.subarray(0, length);
      expect(hasMachoMagic(prefix)).toBe(length >= 4);
      expect(readMachoHeaderPrefixFacts(prefix)).toEqual({
        magic: length < 4 ? null : magic,
        format: length < 4 ? null : format,
        identity: length < 12 ? null : expected.identity,
      });
      expect(readMachoHeaderDeclarations(prefix, 32)).toEqual(
        length < 4
          ? { ok: true, value: null }
          : {
              ok: false,
              error: `truncated Mach-O header: a ${wide ? 64 : 32}-bit header needs ${format.headerSize} bytes; the file has 32`,
            },
      );
    }
    expect(claimsExecutableHeader(bytes.subarray(0, 4))).toBe(true);
    expect(parseExecutableHeader(bytes.subarray(0, 4), "arm64")).toEqual({
      ok: false,
      error: "truncated or unsupported binary header",
    });
    expect(readMachoHeaderDeclarations(bytes, 32)).toEqual({
      ok: true,
      value: expected,
    });
    expect(readMachoLoadCommandDeclarations(bytes, 32)).toEqual(
      wide
        ? {
            ok: false,
            error:
              "truncated Mach-O header: a 64-bit header needs 32 bytes; the file has 32",
          }
        : { ok: true, value: expected },
    );
    const complete = backing.subarray(7, wide ? 39 : 35);
    expect(readMachoLoadCommandDeclarations(complete, 32)).toEqual({
      ok: true,
      value: expected,
    });
    expect(readMachoLoadCommandTableHeader(complete, 32)).toMatchObject({
      ok: false,
    });
    expect(
      readMachoHeaderDeclarations(bytes.subarray(0, 27), 32),
    ).toMatchObject({ ok: false });
  },
);

it.each([
  0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca, 0x7f454c46, 0xffffffff,
])(
  "retains raw non-thin magic %s without thin format or CPU claims",
  (magic) => {
    const bytes = Buffer.alloc(12, 0xff);
    bytes.writeUInt32BE(magic, 0);
    expect(hasMachoMagic(bytes.subarray(0, 4))).toBe(
      magic !== 0x7f454c46 && magic !== 0xffffffff,
    );
    expect(readMachoHeaderPrefixFacts(bytes)).toEqual({
      magic,
      format: null,
      identity: null,
    });
    expect(readMachoHeaderDeclarations(bytes, bytes.length)).toEqual({
      ok: true,
      value: null,
    });
  },
);

it("reads linkedit data fields and refuses a truncated command", () => {
  const body = Buffer.alloc(16);
  body.writeUInt32LE(0x1234, 8);
  body.writeUInt32LE(0x56, 12);
  expect(readMachoLinkeditDataCommand(0x1d, body, true)).toEqual({
    dataOffset: 0x1234,
    dataSize: 0x56,
  });
  expect(
    readMachoLinkeditDataCommand(0x1d, body.subarray(0, 15), true),
  ).toBeNull();
  // The layout comes from the shared fixed-word table, so other layouts refuse.
  expect(readMachoLinkeditDataCommand(0x2, Buffer.alloc(24), true)).toBeNull();
});

it("reads big-endian linkedit data fields", () => {
  const body = Buffer.alloc(16);
  body.writeUInt32BE(0x1234, 8);
  body.writeUInt32BE(0x56, 12);
  expect(readMachoLinkeditDataCommand(0x1d, body, false)).toEqual({
    dataOffset: 0x1234,
    dataSize: 0x56,
  });
});

it("reads symtab fields through the shared fixed-word decoder", () => {
  const body = Buffer.alloc(24);
  body.writeUInt32BE(0x2, 0);
  body.writeUInt32BE(24, 4);
  body.writeUInt32BE(0x100, 8);
  body.writeUInt32BE(3, 12);
  body.writeUInt32BE(0x200, 16);
  body.writeUInt32BE(0x40, 20);
  const fields = { symoff: 0x100, nsyms: 3, stroff: 0x200, strsize: 0x40 };
  expect(readMachoSymtabCommand(body, false)).toEqual(fields);
  expect(decodeMachoFixedWordFields(0x2, body.subarray(8), false)).toEqual(
    fields,
  );
  expect(readMachoSymtabCommand(body.subarray(0, 23), false)).toBeNull();
  expect(decodeMachoFixedWordFields(0x19, body.subarray(8), false)).toBe(
    undefined,
  );
});
