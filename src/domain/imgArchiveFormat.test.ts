import { expect, it } from "vitest";
import { buildImgV2 } from "../../tests/fixtures/imgAnp3.js";
import {
  IMG_V2_HEADER_BYTES,
  imgV2DirectoryBytes,
  hasImgV2Header,
  parseImgV2Directory,
  readImgV2EntryCount,
} from "./imgArchiveFormat.js";

const directoryOf = (archive: Buffer): Buffer =>
  archive.subarray(
    IMG_V2_HEADER_BYTES,
    IMG_V2_HEADER_BYTES + readImgV2EntryCount(archive) * 32,
  );

it("selects the streaming size when the archive size is 0 and the archive size otherwise", () => {
  const archive = buildImgV2([
    { name: "actor.bin", data: Buffer.alloc(3000, 1) },
    { name: "vehicle.bin", data: Buffer.alloc(10, 2), sizeField: "archive" },
  ]);
  expect(hasImgV2Header(archive)).toBe(true);
  const parsed = parseImgV2Directory(directoryOf(archive), archive.length);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value).toEqual([
    {
      index: 0,
      name: "actor.bin",
      offsetSectors: 1,
      streamingSectors: 2,
      archiveSectors: 0,
      byteOffset: 2048,
      byteLength: 4096,
    },
    {
      index: 1,
      name: "vehicle.bin",
      offsetSectors: 3,
      streamingSectors: 0,
      archiveSectors: 1,
      byteOffset: 6144,
      byteLength: 2048,
    },
  ]);
});

it("refuses a directory that cannot fit in the file", () => {
  const archive = buildImgV2([]);
  archive.writeUInt32LE(1_000, 4);
  expect(
    imgV2DirectoryBytes(readImgV2EntryCount(archive), archive.length),
  ).toEqual({ ok: false, error: expect.stringContaining("1000 directory") });
  expect(imgV2DirectoryBytes(0, archive.length)).toEqual({
    ok: true,
    value: 0,
  });
});

it.each([
  {
    label: "a member beyond the file",
    modify: (archive: Buffer) => archive.writeUInt16LE(9, 8 + 4),
    reason: "beyond the",
  },
  {
    label: "a member inside the directory",
    modify: (archive: Buffer) => archive.writeUInt32LE(0, 8),
    reason: "inside the directory",
  },
  {
    label: "an unterminated name",
    modify: (archive: Buffer) => archive.fill(0x41, 16, 40),
    reason: "not NUL-terminated",
  },
  {
    label: "an empty name",
    modify: (archive: Buffer) => archive.fill(0, 16, 40),
    reason: "empty name",
  },
  {
    label: "a nested path",
    modify: (archive: Buffer) => archive.write("../a.bin\0", 16, "latin1"),
    reason: "single path component",
  },
])("refuses $label", ({ modify, reason }) => {
  const archive = buildImgV2([{ name: "actor.bin", data: Buffer.alloc(16) }]);
  modify(archive);
  expect(parseImgV2Directory(directoryOf(archive), archive.length)).toEqual({
    ok: false,
    error: expect.stringContaining(reason),
  });
});

it("keeps empty members at any offset and does not claim a non-VER2 header", () => {
  const archive = buildImgV2([{ name: "empty", data: Buffer.alloc(0) }]);
  archive.writeUInt32LE(0, 8);
  expect(parseImgV2Directory(directoryOf(archive), archive.length)).toEqual({
    ok: true,
    value: [expect.objectContaining({ name: "empty", byteLength: 0 })],
  });
  expect(hasImgV2Header(Buffer.from("VER1\0\0\0\0"))).toBe(false);
  expect(hasImgV2Header(Buffer.from("VER2"))).toBe(false);
});
