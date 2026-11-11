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
  unsupported.writeUInt16LE(4, 4);
  const malformed = journalRecord();
  malformed.writeUInt16LE(12, 56);
  const results = [
    ...readUsnJournal(Buffer.concat([unsupported, malformed, journalRecord()])),
  ];
  expect(results).toMatchObject([
    {
      ok: false,
      error: { kind: "unsupported", fileOffset: 0, major: 4, minor: 0 },
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
