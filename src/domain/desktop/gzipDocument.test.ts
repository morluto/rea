import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { openStateDocument, UNREADABLE_GZIP } from "./gzipDocument.js";
import { textualView } from "./stateFormats.js";
import {
  DESKTOP_VIEW_DEFAULTS,
  desktopViewPolicy,
  type DesktopViewPolicy,
} from "./desktopViewPolicy.js";
import { zipArchive } from "./zipArchive.fixture.js";

const MIB = 1024 * 1024;
/** A Gnumeric workbook's XML, which Gnumeric saves gzip-compressed as `.gnumeric`. */
const GNUMERIC = `<?xml version="1.0" encoding="UTF-8"?>
<gnm:Workbook xmlns:gnm="http://www.gnumeric.org/v10.dtd">
  <gnm:Sheets><gnm:Sheet><gnm:Name>Budget</gnm:Name><gnm:Cells>
    <gnm:Cell Row="1" Col="2" ValueType="40">437.8</gnm:Cell>
  </gnm:Cells></gnm:Sheet></gnm:Sheets>
</gnm:Workbook>
`;

/** What the state view reads from a file's bytes: its format, compression, and view or error. */
const read = (
  name: string,
  bytes: Uint8Array,
  policy: DesktopViewPolicy = DESKTOP_VIEW_DEFAULTS,
) => {
  const document = openStateDocument(name, bytes, policy);
  if ("error" in document) return document;
  const { format, compression } = document;
  return format === "text" || format === "xml"
    ? { format, compression, view: textualView(format, document.bytes, policy) }
    : { format, compression };
};

describe("openStateDocument", () => {
  it("recovers the selected gzip document size and inner text view budgets", () => {
    const bytes = gzipSync("one\ntwo\nthree");
    expect(
      read("notes", bytes, desktopViewPolicy({ zip_entry_bytes: 12 })),
    ).toMatchObject({
      compression: "gzip",
      error: "larger than the 12 bytes a compressed document's view reads",
    });
    expect(
      read(
        "notes",
        bytes,
        desktopViewPolicy({ zip_entry_bytes: 13, text_lines: 2 }),
      ),
    ).toMatchObject({
      compression: "gzip",
      view: { ok: true, value: { lines: ["one", "two"], truncated: true } },
    });
    expect(
      read(
        "notes",
        bytes,
        desktopViewPolicy({ zip_entry_bytes: 13, text_lines: 3 }),
      ),
    ).toMatchObject({
      compression: "gzip",
      view: {
        ok: true,
        value: { lines: ["one", "two", "three"], truncated: false },
      },
    });
  });

  it("reads a gzip file's XML document as the same view the document has uncompressed", () => {
    expect(read("Budget.gnumeric", gzipSync(GNUMERIC))).toEqual({
      ...read("Budget.gnumeric", Buffer.from(GNUMERIC)),
      compression: "gzip",
    });
    expect(read("Budget.gnumeric", Buffer.from(GNUMERIC))).toMatchObject({
      format: "xml",
      compression: undefined,
      view: { ok: true },
    });
  });

  it("joins a stream's members, and ends it at padding that starts with a zero byte", () => {
    const one = gzipSync("one\n");
    const two = gzipSync("two\n");

    expect(read("notes", Buffer.concat([one, two]))).toMatchObject({
      view: { ok: true, value: { lines: ["one", "two"] } },
    });
    expect(
      read("notes", Buffer.concat([one, Buffer.alloc(3), two])),
    ).toMatchObject({
      view: { ok: true, value: { lines: ["one"] } },
    });
  });

  it.each([
    [
      "a damaged checksum",
      (bytes: Buffer) =>
        Buffer.concat([bytes.subarray(0, -8), Buffer.alloc(8, 1)]),
    ],
    ["a stream cut short", (bytes: Buffer) => bytes.subarray(0, -10)],
    [
      "data after a member",
      (bytes: Buffer) => Buffer.concat([bytes, Buffer.from("junk")]),
    ],
  ])("reads none of a stream with %s, and says so", (_name, damage) => {
    expect(read("Budget.gnumeric", damage(gzipSync(GNUMERIC)))).toEqual({
      format: null,
      compression: "gzip",
      error: UNREADABLE_GZIP,
    });
  });

  it("stops decompressing past 100 times the file's size or 16 MiB, as for an archive entry", () => {
    const bomb = gzipSync(Buffer.alloc(MIB, 0x20));
    const large = gzipSync(randomBytes(9 * MIB).toString("hex"));

    expect(read("bomb.xml", bomb)).toEqual({
      format: null,
      compression: "gzip",
      error: "expands more than 100 times, so it is not read",
    });
    expect(read("large.txt", large)).toEqual({
      format: null,
      compression: "gzip",
      error: "larger than the 16 MiB a compressed document's view reads",
    });
  });

  it("reads an archive inside, but neither a database nor another gzip stream", () => {
    const sqlite = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.alloc(84),
    ]);

    expect(
      read(
        "plate.FCStd.gz",
        gzipSync(zipArchive([{ name: "a.txt", data: "a" }])),
      ),
    ).toEqual({
      format: "zip",
      compression: "gzip",
    });
    expect(read("notes.db.gz", gzipSync(sqlite))).toEqual({
      format: "sqlite",
      compression: "gzip",
      error: "a SQLite database inside a gzip file is not read",
    });
    expect(read("twice.gz", gzipSync(gzipSync("x")))).toEqual({
      format: "binary",
      compression: "gzip",
    });
  });
});
