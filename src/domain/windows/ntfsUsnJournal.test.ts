import { expect, it } from "vitest";
import { readUsnJournal } from "./ntfsUsnJournal.js";

const journalRecord = (): Buffer => {
  const bytes = Buffer.alloc(72);
  bytes.writeUInt32LE(bytes.length);
  bytes.writeUInt16LE(2, 4);
  bytes.writeBigUInt64LE(0xabcd_1234_5678_9abcn, 8);
  bytes.writeBigUInt64LE(0x1234_0000_0000_0005n, 16);
  bytes.writeBigInt64LE(9007199254740993n, 24);
  bytes.writeBigUInt64LE(133000000000000001n, 32);
  bytes.writeUInt32LE(0x80001000, 40);
  bytes.writeUInt32LE(4, 44);
  bytes.writeUInt16LE(8, 56);
  bytes.writeUInt16LE(62, 58);
  bytes.write("a😃b", 62, "utf16le");
  return bytes;
};

it("preserves full references, flags, offsets and UTF-16 names after sparse padding", () => {
  const results = [
    ...readUsnJournal(Buffer.concat([Buffer.alloc(16), journalRecord()])),
  ];
  expect(results).toEqual([
    { ok: false, error: { kind: "padding", fileOffset: 0, bytes: 16 } },
    {
      ok: true,
      value: {
        majorVersion: 2,
        referenceBytes: 8,
        fileOffset: 16,
        recordBytes: 72,
        fileReference: 0xabcd_1234_5678_9abcn,
        parentReference: 0x1234_0000_0000_0005n,
        usn: 9007199254740993n,
        timestampFileTime: 133000000000000001n,
        reasonFlags: 0x80001000,
        sourceFlags: 4,
        securityId: 0,
        fileAttributes: 0,
        name: "a😃b",
      },
    },
  ]);
});

it("uses a validated record length to skip unsupported and malformed records", () => {
  const unsupported = journalRecord();
  unsupported.writeUInt16LE(9, 4);
  const malformed = journalRecord();
  malformed.writeUInt16LE(12, 56);
  const results = [
    ...readUsnJournal(Buffer.concat([unsupported, malformed, journalRecord()])),
  ];
  expect(results).toMatchObject([
    {
      ok: false,
      error: { kind: "unsupported", fileOffset: 0, major: 9, minor: 0 },
    },
    { ok: false, error: { kind: "malformed", fileOffset: 72 } },
    { ok: true, value: { fileOffset: 144 } },
  ]);
});

it("stops at a truncated record", () => {
  expect([...readUsnJournal(journalRecord().subarray(0, 64))]).toEqual([
    { ok: false, error: { kind: "truncated", fileOffset: 0 } },
  ]);
});

it("decodes V3 opaque 128-bit identifiers without narrowing to MFT references", () => {
  const bytes = Buffer.alloc(88);
  bytes.writeUInt32LE(bytes.length);
  bytes.writeUInt16LE(3, 4);
  bytes.writeBigUInt64LE(0x0002_0000_0000_0007n, 8);
  bytes.writeBigUInt64LE(0xfedcba9876543210n, 16);
  bytes.writeBigUInt64LE(9007199254740993n, 24);
  bytes.writeBigInt64LE(9007199254740993n, 40);
  bytes.writeBigUInt64LE(133000000000000001n, 48);
  bytes.writeUInt16LE(6, 72);
  bytes.writeUInt16LE(76, 74);
  bytes.write("new", 76, "utf16le");
  expect([...readUsnJournal(bytes)]).toMatchObject([
    {
      ok: true,
      value: {
        majorVersion: 3,
        referenceBytes: 16,
        name: "new",
        fileReference: 0xfedcba98765432100002000000000007n,
        parentReference: 9007199254740993n,
        usn: 9007199254740993n,
        timestampFileTime: 133000000000000001n,
      },
    },
  ]);
  bytes.writeUInt16LE(60, 74);
  expect([...readUsnJournal(bytes)]).toEqual([
    { ok: false, error: { kind: "malformed", fileOffset: 0 } },
  ]);
});

it("bounds V4 extent delivery while retaining full coverage counts and continuation state", () => {
  const bytes = Buffer.alloc(64 + 17 * 24);
  bytes.writeUInt32LE(bytes.length);
  bytes.writeUInt16LE(4, 4);
  bytes.writeUInt32LE(40, 56);
  bytes.writeUInt16LE(17, 60);
  bytes.writeUInt16LE(24, 62);
  bytes.writeBigInt64LE(9007199254740993n, 64);
  bytes.writeBigInt64LE(-1n, 72);
  const [result] = readUsnJournal(bytes);
  if (!result?.ok) throw new Error("Invalid V4 fixture");
  expect(result.value).toMatchObject({
    majorVersion: 4,
    referenceBytes: 16,
    name: null,
    timestampFileTime: null,
    extentCount: 17,
    extentSize: 24,
    remainingExtents: 40,
    omittedExtents: 1,
  });
  expect(result.value.extentSample).toHaveLength(16);
  expect(result.value.extentSample?.[0]).toEqual({
    fileOffset: 64,
    offset: 9007199254740993n,
    length: -1n,
  });
  expect(result.value.extentSample?.[15]?.fileOffset).toBe(424);
});

it.each([
  [15, 1],
  [16, 65535],
])(
  "refuses V4 stride %i / count %i before extent allocation",
  (stride, count) => {
    const bytes = Buffer.alloc(80);
    bytes.writeUInt32LE(80);
    bytes.writeUInt16LE(4, 4);
    bytes.writeUInt16LE(count, 60);
    bytes.writeUInt16LE(stride, 62);
    expect([...readUsnJournal(bytes)]).toEqual([
      { ok: false, error: { kind: "malformed", fileOffset: 0 } },
    ]);
  },
);
