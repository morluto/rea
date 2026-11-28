import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  MAX_PROGRAM_TREE_MEMBERS,
  MAX_PROGRAM_TREE_NAME_BYTES,
  parseProgramTreeZip,
} from "./LabviewProgramTree.js";
import { labviewZipArchive } from "../../tests/fixtures/labview/rsrc.js";

const names = (scan: ReturnType<typeof parseProgramTreeZip>): string[] =>
  scan.ok ? scan.value.members.map(({ name }) => name) : [];

describe("parseProgramTreeZip", () => {
  it("lists file members and omits directory entries", () => {
    const scan = parseProgramTreeZip(
      labviewZipArchive([
        { name: "a.vi", content: Buffer.from("one") },
        { name: "lib/", content: Buffer.alloc(0) },
        { name: "lib/b.vi", content: Buffer.from("two") },
      ]),
    );
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value.entryCount).toBe(2);
    expect(scan.value.totalBytes).toBe(6);
    expect(scan.value.members.map(({ name }) => name)).toEqual([
      "a.vi",
      "lib/b.vi",
    ]);
  });

  it("reports the declared sizes and encryption flag", () => {
    const scan = parseProgramTreeZip(
      labviewZipArchive([
        { name: "plain.vi", content: Buffer.from("abc") },
        { name: "locked.vi", content: Buffer.from("abcd"), encrypted: true },
      ]),
    );
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value.members[0]).toMatchObject({
      bytes: 3,
      storedBytes: 3,
      method: 0,
      encrypted: false,
    });
    expect(scan.value.members[1]).toMatchObject({
      bytes: 4,
      encrypted: true,
    });
  });

  it("decodes a UTF-8 name when the entry flag says so", () => {
    const scan = parseProgramTreeZip(
      labviewZipArchive([
        { name: "café.vi", content: Buffer.from("x"), utf8: true },
      ]),
    );
    expect(names(scan)).toEqual(["café.vi"]);
  });

  it("keeps the recorded bytes when a legacy name is not ASCII", () => {
    const scan = parseProgramTreeZip(
      labviewZipArchive([
        {
          name: "ignored.vi",
          rawName: Buffer.from([0xe9, 0x2e, 0x76, 0x69]),
          content: Buffer.from("x"),
        },
      ]),
    );
    expect(scan.ok).toBe(true);
    if (scan.ok)
      expect(scan.value.members[0]).toMatchObject({
        rawNameHex: "e92e7669",
      });
  });

  it("uses the Info-ZIP Unicode Path extra field when its CRC matches", () => {
    const recorded = Buffer.from("legacy.vi", "latin1");
    const unicode = Buffer.from("日本語.vi", "utf8");
    const extra = Buffer.alloc(4 + 5 + unicode.length);
    extra.writeUInt16LE(0x70_75, 0);
    extra.writeUInt16LE(5 + unicode.length, 2);
    extra.writeUInt8(1, 4);
    extra.writeUInt32LE(crc32(recorded) >>> 0, 5);
    unicode.copy(extra, 9);
    const scan = parseProgramTreeZip(
      labviewZipArchive([
        { name: "legacy.vi", content: Buffer.from("x"), extra },
      ]),
    );
    expect(names(scan)).toEqual(["日本語.vi"]);
  });

  it("refuses more members than the representation allowance", () => {
    const many = Array.from(
      { length: MAX_PROGRAM_TREE_MEMBERS + 1 },
      (_, index) => ({ name: `v${index}`, content: Buffer.alloc(0) }),
    );
    const scan = parseProgramTreeZip(labviewZipArchive(many));
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.reason).toContain("above the 4096");
  });

  it("charges a Unicode-path name to the representation allowance", () => {
    const rawName = Buffer.from("a");
    const unicodeName = Buffer.from("\u0001".repeat(18_000), "utf8");
    const extra = Buffer.alloc(4 + 5 + unicodeName.length);
    extra.writeUInt16LE(0x70_75, 0);
    extra.writeUInt16LE(5 + unicodeName.length, 2);
    extra.writeUInt8(1, 4);
    extra.writeUInt32LE(crc32(rawName) >>> 0, 5);
    unicodeName.copy(extra, 9);
    // The recorded name is one byte; the retained Unicode name is 18,000.
    const count = Math.ceil(MAX_PROGRAM_TREE_NAME_BYTES / 18_000) + 1;
    const members = Array.from({ length: count }, () => ({
      name: "a",
      rawName,
      content: Buffer.alloc(0),
      extra,
    }));
    const scan = parseProgramTreeZip(labviewZipArchive(members));
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.reason).toContain("member names total");
  });

  it("refuses an aggregate name representation above the allowance", () => {
    const name = "n".repeat(65_535);
    const count = Math.ceil(MAX_PROGRAM_TREE_NAME_BYTES / 65_535) + 1;
    const many = Array.from({ length: count }, () => ({
      name,
      content: Buffer.alloc(0),
    }));
    const scan = parseProgramTreeZip(labviewZipArchive(many));
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.reason).toContain("member names total");
  });

  it("rejects an aggregate size above the safe integer range", () => {
    const huge = { bytes: 2n ** 52n, storedBytes: 1n };
    const scan = parseProgramTreeZip(
      labviewZipArchive([
        { name: "a.vi", content: Buffer.alloc(0), zip64: huge },
        { name: "b.vi", content: Buffer.alloc(0), zip64: huge },
      ]),
    );
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.reason).toContain("integer range");
  });

  it("rejects an ambiguous end record instead of an empty tree", () => {
    const archive = Buffer.from(
      labviewZipArchive([{ name: "a.vi", content: Buffer.from("x") }]),
    );
    // A 22-byte comment that itself looks like an empty end record.
    const comment = Buffer.alloc(22);
    comment.writeUInt32LE(0x06_05_4b_50, 0);
    archive.writeUInt16LE(comment.length, archive.length - 2);
    const scan = parseProgramTreeZip(Buffer.concat([archive, comment]));
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.reason).toContain("ambiguous");
  });

  it("ignores an invalid decoy end record before the real one", () => {
    const archive = Buffer.from(
      labviewZipArchive([{ name: "a.vi", content: Buffer.from("x") }]),
    );
    const eocdAt = archive.length - 22;
    const centralSize = archive.readUInt32LE(eocdAt + 12);
    const centralStart = eocdAt - centralSize;
    // Put the decoy inside the central entry's comment, before the real end
    // record, with directory fields that cannot describe this archive.
    const decoy = Buffer.alloc(22);
    decoy.writeUInt32LE(0x06_05_4b_50, 0);
    decoy.writeUInt32LE(0xff_ff_ff_f0, 12);
    decoy.writeUInt32LE(0xff_ff_ff_f0, 16);
    decoy.writeUInt16LE(22, 20);
    archive.writeUInt16LE(22, centralStart + 32);
    archive.writeUInt32LE(centralSize + 22, eocdAt + 12);
    const withDecoy = Buffer.concat([
      archive.subarray(0, eocdAt),
      decoy,
      archive.subarray(eocdAt),
    ]);
    expect(names(parseProgramTreeZip(withDecoy))).toEqual(["a.vi"]);
  });

  it("accepts an empty archive", () => {
    const scan = parseProgramTreeZip(labviewZipArchive([]));
    expect(scan.ok && scan.value.entryCount).toBe(0);
  });

  it("preserves a leading BOM in a UTF-8 name", () => {
    const scan = parseProgramTreeZip(
      labviewZipArchive([
        { name: "\uFEFFdemo.vi", content: Buffer.from("x"), utf8: true },
      ]),
    );
    expect(names(scan)).toEqual(["\uFEFFdemo.vi"]);
  });

  it("rejects conflicting end-record counts", () => {
    const archive = Buffer.from(
      labviewZipArchive([
        { name: "a.vi", content: Buffer.from("1") },
        { name: "b.vi", content: Buffer.from("2") },
      ]),
    );
    // Declare one total entry while the on-disk count still says two.
    archive.writeUInt16LE(1, archive.length - 12);
    const scan = parseProgramTreeZip(archive);
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.reason).toContain("central directory");
  });

  it("rejects a count that stops before the directory ends", () => {
    const archive = Buffer.from(
      labviewZipArchive([
        { name: "a.vi", content: Buffer.from("1") },
        { name: "b.vi", content: Buffer.from("2") },
      ]),
    );
    // Both counts say one, but the directory still holds two records.
    archive.writeUInt16LE(1, archive.length - 14);
    archive.writeUInt16LE(1, archive.length - 12);
    const scan = parseProgramTreeZip(archive);
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.reason).toContain("central directory");
  });

  it("rejects a multi-disk archive", () => {
    const archive = Buffer.from(labviewZipArchive([]));
    archive.writeUInt16LE(1, archive.length - 18);
    const scan = parseProgramTreeZip(archive);
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.reason).toContain("multiple disks");
  });

  it("rejects a declared directory larger than the archive", () => {
    const archive = Buffer.from(labviewZipArchive([]));
    archive.writeUInt32LE(0xff_ff_ff_00, archive.length - 10);
    const scan = parseProgramTreeZip(archive);
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.reason).toContain("central directory");
  });

  it("rejects bytes with no end record", () => {
    const scan = parseProgramTreeZip(Buffer.from("not a zip at all"));
    expect(scan.ok).toBe(false);
  });

  it("does not mistake a stray signature inside a comment for the end record", () => {
    const archive = Buffer.from(labviewZipArchive([]));
    const comment = Buffer.alloc(30);
    comment.writeUInt32LE(0x06_05_4b_50, 0);
    comment.writeUInt16LE(5, 20);
    archive.writeUInt16LE(comment.length, archive.length - 2);
    const scan = parseProgramTreeZip(Buffer.concat([archive, comment]));
    expect(scan.ok).toBe(true);
    if (scan.ok) expect(scan.value.entryCount).toBe(0);
  });
});
