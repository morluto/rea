import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import { zipArchive } from "../../../src/domain/desktop/zipArchive.fixture.js";
import {
  expectSameCheckResults,
  expectSameFileViews,
  exportedPython,
  savedEnds,
  typescriptFileView,
  writeFiles,
} from "../../support/desktopExportPython.js";

const MIB = 1024 * 1024;
const POSTER = "Pictures/poster.svgz";
const HEADLINE: DesktopTaskCheck = {
  id: "headline",
  kind: "value_equals",
  file: POSTER,
  pointer:
    "/root/children/[name=g][@inkscape:label=Layer 1]/children/[name=text][@id=headline]/children/[name=tspan]/children/0",
  value: "Summer Bake Sale",
};

/** Inkscape's saves of the poster, before and after the headline was changed, compressed as its `.svgz`. */
const posters = () =>
  savedEnds("inkscape", "poster.svg", "poster.svgz", (bytes) =>
    gzipSync(bytes),
  );

const gnumeric = gzipSync(
  '<?xml version="1.0" encoding="UTF-8"?>\n<gnm:Workbook xmlns:gnm="http://www.gnumeric.org/v10.dtd"><gnm:Cell Row="1" Col="2">437.8</gnm:Cell></gnm:Workbook>\n',
);
const bomb = gzipSync(Buffer.alloc(MIB, 0x20));
const sqlite = Buffer.concat([
  Buffer.from("SQLite format 3\0"),
  Buffer.alloc(84),
]);

describe("gzip files in the exported module", () => {
  it("reads a compressed drawing as the view of the drawing inside, and grades it alike", async () => {
    const files = await posters();
    const [, plain] = await savedEnds("inkscape", "poster.svg");
    const [, after] = files;
    if (plain === undefined || after === undefined) throw new Error("fixture");

    await expectSameFileViews(files);
    expect(await typescriptFileView(after)).toEqual({
      ...(await typescriptFileView(plain)),
      compression: "gzip",
    });
    const outcomes = await expectSameCheckResults(POSTER, [HEADLINE], files);
    expect(outcomes.map(([outcome]) => outcome?.passed)).toEqual([false, true]);
  });

  it("reads the same members, padding, damage, limits and documents inside in both readers", async () => {
    const one = gzipSync("one\n");
    const files = [
      { name: "Budget.gnumeric", bytes: gnumeric },
      {
        // gzip(1)'s header: a file name and modification time.
        name: "named.gnumeric",
        bytes: Buffer.concat([
          Buffer.from([0x1f, 0x8b, 8, 8, 1, 2, 3, 4, 0, 3]),
          Buffer.from("Budget.gnumeric\0"),
          gnumeric.subarray(10),
        ]),
      },
      { name: "notes", bytes: Buffer.concat([one, gzipSync("two\n")]) },
      {
        name: "notes",
        bytes: Buffer.concat([one, Buffer.alloc(3), gzipSync("two\n")]),
      },
      { name: "settings.json", bytes: gzipSync('{"zoom": 1.5}') },
      { name: "app.ini", bytes: gzipSync("[ui]\nwrap=false\n") },
      {
        name: "plate.FCStd",
        bytes: gzipSync(zipArchive([{ name: "a.json", data: '{"x": 1}' }])),
      },
      { name: "notes.db", bytes: gzipSync(sqlite) },
      { name: "twice.gz", bytes: gzipSync(gzipSync("x")) },
      {
        name: "crc.xml",
        bytes: Buffer.concat([gnumeric.subarray(0, -8), Buffer.alloc(8, 1)]),
      },
      { name: "cut.xml", bytes: gnumeric.subarray(0, -10) },
      { name: "junk.xml", bytes: Buffer.concat([gnumeric, Buffer.from("x")]) },
      { name: "bomb.xml", bytes: bomb },
      {
        name: "large.txt",
        bytes: gzipSync(randomBytes(9 * MIB).toString("hex")),
      },
    ];

    await expectSameFileViews(files);
    const views = await Promise.all(files.map(typescriptFileView));
    expect(views.map(({ format, error }) => [format, error ?? null])).toEqual([
      ["xml", null],
      ["xml", null],
      ["text", null],
      ["text", null],
      ["json", null],
      ["keyfile", null],
      ["zip", null],
      ["sqlite", "a SQLite database inside a gzip file is not read"],
      ["binary", null],
      [null, "not a readable gzip stream"],
      [null, "not a readable gzip stream"],
      [null, "not a readable gzip stream"],
      [null, "expands more than 100 times, so it is not read"],
      [null, "larger than the 16 MiB a compressed document's view reads"],
    ]);
    expect(views.every(({ compression }) => compression === "gzip")).toBe(true);
  });

  it("reads a stream of many members a piece at a time, so the end of each copies no more than that piece", async () => {
    // 80,000 empty members: no output, so neither limit stops the read.
    const empty = gzipSync(Buffer.alloc(0));
    const file = {
      name: "notes",
      bytes: Buffer.concat(Array.from({ length: 80_000 }, () => empty)),
    };
    await expectSameFileViews([file]);

    const { size, peak } = JSON.parse(
      exportedPython(
        `import tracemalloc
data = Path(json.load(sys.stdin)[0]).read_bytes()
tracemalloc.start()
size = len(_gunzip(data, MAX_ZIP_ENTRY_BYTES))
print(json.dumps({"size": size, "peak": tracemalloc.get_traced_memory()[1]}))`,
        await writeFiles([file]),
      ),
    ) as { size: number; peak: number };

    expect(size).toBe(0);
    expect(peak).toBeLessThan(256 * 1024);
  });

  it("fails a check into a gzip file it did not read, undecided in REA, alike in both", async () => {
    const file = "Documents/bomb.xml";
    const [outcomes] = await expectSameCheckResults(
      file,
      [
        {
          id: "gone",
          kind: "value_absent",
          file,
          pointer: "/root/attributes/x",
        },
      ],
      [{ name: "bomb.xml", bytes: bomb }],
    );

    expect(
      outcomes?.map(({ passed, undecided }) => [passed, undecided]),
    ).toEqual([[false, true]]);
  });
});
