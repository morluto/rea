import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";

import { describe, expect, it } from "vitest";

import { readZipView } from "../../../src/application/desktop/DesktopZipView.js";
import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { detectStateFormat } from "../../../src/domain/desktop/stateFormats.js";
import {
  emptyEntriesArchive,
  odtArchive,
  unicodePathExtra,
  withZip64End,
  zipArchive,
  type ZipMember,
} from "../../../src/domain/desktop/zipArchive.fixture.js";
import { zipEntryRefusal } from "../../../src/domain/desktop/zipView.js";
import {
  desktopViewPolicy,
  pythonDesktopViewPolicy,
  type DesktopViewPolicy,
} from "../../../src/domain/desktop/desktopViewPolicy.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  expectSameCheckResults,
  expectSameFileViews,
  exportedPython,
  pythonFileViews,
  typescriptFileView,
  writeFiles,
} from "../../support/desktopExportPython.js";
import {
  decodeZipEntryText,
  ZIP_READER_OPTIONS,
  zipEntryPath,
} from "../../../src/resources/index.js";

const MIB = 1024 * 1024;
const FIXTURES = join(import.meta.dirname, "../../fixtures/freecad");

/** Archives as FreeCAD documents under the home. */
const saved = (archives: readonly Buffer[]) =>
  archives.map((bytes) => ({ name: "plate.FCStd", bytes }));

const expectSameViews = (
  archives: readonly Buffer[],
  policy?: DesktopViewPolicy,
) => expectSameFileViews(saved(archives), policy);

/** REA's view of an archive, once the exported module's is shown to be the same. */
const sameView = async (archive: Buffer, policy?: DesktopViewPolicy) => {
  const [file] = await expectSameViews([archive], policy);
  if (file?.view == null) throw new Error(file?.error ?? "No ZIP view");
  return file.view;
};

/** The exported module's zip view of an archive file, and the most memory reading it traced. */
const pythonPeak = async (archive: Buffer) =>
  JSON.parse(
    exportedPython(
      `import tracemalloc
tracemalloc.start()
file = _view(Path(json.load(sys.stdin)[0]))
peak = tracemalloc.get_traced_memory()[1]
tracemalloc.stop()
print(json.dumps({"file": file, "peak": peak}))`,
      await writeFiles(saved([archive])),
    ),
  ) as {
    file: {
      format: "zip";
      truncated: boolean;
      view: {
        entries: Record<string, JsonValue>[];
        entry_count: number;
        truncated: boolean;
      };
    };
    peak: number;
  };

const expectSameTrackedView = async (archive: Buffer) => {
  const {
    file: { truncated, ...file },
    peak,
  } = await pythonPeak(archive);
  expect(file).toEqual(
    await typescriptFileView({ name: "plate.FCStd", bytes: archive }),
  );
  expect(truncated).toBe(file.view.truncated);
  return { file, peak };
};

const sqliteHeader = Buffer.concat([
  Buffer.from("SQLite format 3\0"),
  Buffer.alloc(84),
]);

it("gives the UTF-8 flag precedence over a Unicode Path for names and formats", async () => {
  const storedName = "legacy.txt";
  const extra = unicodePathExtra(storedName, "café.json");
  const archive = zipArchive([
    { name: storedName, data: "42", flags: 0x800, centralExtra: extra },
    { name: "other.txt", data: "42", centralExtra: extra },
  ]);

  expect(await sameView(archive)).toMatchObject({
    entries: [
      { name: storedName, format: "text" },
      { name: "other.txt", format: "text" },
    ],
  });
});

it.each([
  "crc",
  "version",
  "short",
  "superseded-utf8",
  "flagged",
  "empty",
  "nul",
])(
  "keeps the ZIP decoder's final Unicode Path choice through bounded views (%s)",
  async (kind) => {
    const name = "settings.json";
    const displayed =
      kind === "empty" ? "" : kind === "nul" ? "kept\0.json" : name;
    const first = unicodePathExtra(
      name,
      kind === "superseded-utf8" ? Buffer.from([0xff]) : "hidden/",
    );
    let last = unicodePathExtra(name, displayed);
    if (kind === "crc") last.writeUInt32LE(0, 5);
    if (kind === "version") last[4] = 2;
    if (kind === "short") last = Buffer.from([0x75, 0x70, 1, 0, 1]);
    const archive = zipArchive([
      {
        name,
        data: '{"zoom":2}',
        flags: kind === "flagged" ? 0x800 : 0,
        centralExtra: Buffer.concat([first, last]),
      },
      { name: "control.txt", data: "unaffected" },
    ]);
    // The complete production decoder is the semantic control for the bounded
    // preflight, including invalid final claims falling back to the raw name.
    const reader = new ZipReader(
      new Uint8ArrayReader(archive),
      ZIP_READER_OPTIONS,
    );
    try {
      expect(
        (await reader.getEntries({ decodeText: decodeZipEntryText })).map(
          (entry) => ({
            name: zipEntryPath(entry),
            directory: entry.directory,
          }),
        ),
      ).toEqual([
        { name: displayed, directory: false },
        { name: "control.txt", directory: false },
      ]);
    } finally {
      await reader.close();
    }
    expect(await sameView(archive)).toMatchObject({
      entries: [
        {
          name: displayed,
          format: "json",
          view: { zoom: 2 },
          view_error: null,
        },
        { name: "control.txt", view_error: null },
      ],
      entry_count: 2,
      truncated: false,
    });
  },
);

it("refuses invalid UTF-8 in the selected Unicode claim while preserving an unrelated extra field", async () => {
  const name = "settings.json";
  const opaque = Buffer.from([0xfe, 0xca, 3, 0, 1, 2, 3]);
  const archive = (last: Buffer) =>
    zipArchive([
      {
        name,
        data: '{"zoom":2}',
        centralExtra: Buffer.concat([
          unicodePathExtra(name, "hidden/"),
          opaque,
          last,
        ]),
      },
    ]);
  expect(await sameView(archive(unicodePathExtra(name, name)))).toMatchObject({
    entry_count: 1,
    entries: [{ name, view: { zoom: 2 } }],
    truncated: false,
  });
  const invalid = archive(unicodePathExtra(name, Buffer.from([0xff])));
  await expectSameViews([invalid]);
  expect(await readZipView(invalid)).toEqual({
    ok: false,
    error: "not a readable zip archive",
  });
});

it("refuses a central extra field whose payload extends past the containing record's extra bytes", async () => {
  const name = "report.txt";
  const opaque = Buffer.from([0xfe, 0xca, 2, 0, 1]);
  const unicode = unicodePathExtra(name, "renamed.txt");
  unicode.writeUInt16LE(unicode.length - 3, 2);
  const archives = [
    zipArchive([{ name, data: "observed", centralExtra: opaque }]),
    zipArchive([{ name, data: "observed", centralExtra: unicode }]),
    zipArchive([
      { name: "directory/", centralExtra: opaque },
      { name, data: "observed" },
    ]),
  ];
  const fromPython = await pythonFileViews(saved(archives));
  for (const [index, archive] of archives.entries()) {
    expect.soft(await readZipView(archive)).toEqual({
      ok: false,
      error: "not a readable zip archive",
    });
    expect.soft(fromPython[index]).toEqual({
      format: "zip",
      view: null,
      error: "not a readable zip archive",
    });
  }
});

it("excludes a final Unicode directory without consuming a retained file slot", async () => {
  const name = "settings.json";
  const archive = zipArchive([
    {
      name,
      data: "not a file view",
      centralExtra: Buffer.concat([
        unicodePathExtra(name, name),
        unicodePathExtra(name, "hidden/"),
      ]),
    },
    { name: "control.json", data: '{"kept":true}' },
    { name: "later.txt", data: "after the selected limit" },
  ]);
  const policy = desktopViewPolicy({ zip_entries: 1 });
  expect(await sameView(archive, policy)).toMatchObject({
    entries: [{ name: "control.json", view: { kept: true } }],
    entry_count: 2,
    truncated: true,
  });
});

describe("zip views in the exported module", () => {
  it("lists entries in archive order with the formats and views REA reads", async () => {
    const members: ZipMember[] = [
      { name: "settings.json", data: '{"zoom": 1.5, "tags": ["a"]}' },
      { name: "app.ini", data: "[ui]\nwrap=false\n" },
      { name: "doc/", data: "" },
      { name: "doc/page.xml", data: '<page n="1"><t>Hello</t></page>' },
      { name: "notes.txt", data: "one\ntwo\n", method: 0 },
      { name: "café.txt", data: "naïve\n" },
      { name: "image.png", data: Buffer.from([0x89, 0x50, 0, 1, 2]) },
      { name: "inner.zip", data: zipArchive([{ name: "x", data: "y" }]) },
      { name: "store.db", data: sqliteHeader },
      { name: "big.json", data: '{"id": 9007199254740993}' },
    ];

    expect(await sameView(zipArchive(members))).toMatchObject({
      entry_count: 9,
      truncated: false,
      entries: [
        { name: "settings.json", format: "json", view: { zoom: 1.5 } },
        { name: "app.ini", format: "keyfile" },
        { name: "doc/page.xml", format: "xml", view_error: null },
        { name: "notes.txt", format: "text", view: { lines: ["one", "two"] } },
        { name: "café.txt", format: "text" },
        { name: "image.png", format: "binary", view: null, view_error: null },
        {
          name: "inner.zip",
          format: "zip",
          view_error: "an archive inside an archive is not read",
        },
        {
          name: "store.db",
          format: "sqlite",
          view_error: "a SQLite database inside an archive is not read",
        },
        {
          name: "big.json",
          format: "json",
          view_error:
            "a number in it cannot be read exactly, such as an integer above 2^53",
        },
      ],
    });
  });

  it("refuses the same entries for the same reasons, and an archive it cannot read", async () => {
    // A short declared size with the checksum of that prefix still leaves data the entry does not declare.
    const helCrc = crc32(Buffer.from("hel"));
    const archive = zipArchive([
      { name: "secret.txt", data: "x", flags: 1 },
      { name: "bzip2.txt", data: "x", method: 12 },
      { name: "huge.txt", data: "x", method: 0, declaredSize: 17 * MIB },
      { name: "bomb.txt", data: "a".repeat(200_000) },
      { name: "crc.txt", data: "hello", crc: 1 },
      { name: "short.txt", data: "hello", declaredSize: 3 },
      { name: "prefix.txt", data: "hello", declaredSize: 3, crc: helCrc },
      {
        name: "prefix-stored.txt",
        data: "hello",
        method: 0,
        declaredSize: 3,
        crc: helCrc,
      },
      { name: "fine.txt", data: "ok\n" },
    ]);
    const damaged = Buffer.concat([
      Buffer.from("PK\u0003\u0004"),
      Buffer.alloc(60, 7),
    ]);

    const [read, refusal] = await expectSameViews([archive, damaged]);
    expect(read?.view).toMatchObject({
      entries: [
        { view_error: "encrypted, so it is not read", sha256: null },
        {
          view_error: "compressed with method 12, which the view does not read",
        },
        { view_error: "larger than the 16 MiB an entry's view reads" },
        { view_error: "expands more than 100 times, so it is not read" },
        { view_error: "its compressed data is damaged" },
        { view_error: "its compressed data is damaged" },
        { name: "prefix.txt", view_error: "its compressed data is damaged" },
        {
          name: "prefix-stored.txt",
          view_error: "its compressed data is damaged",
        },
        { format: "text", view_error: null },
      ],
    });
    expect(refusal).toEqual({
      format: "zip",
      view: null,
      error: "not a readable zip archive",
    });
  });

  it("stops reading an archive at 64 MiB of entries, as the exported reader does", () => {
    const headers = [
      [{ size: 10, compressedSize: 10 }, 64 * MIB - 10],
      [{ size: 11, compressedSize: 11 }, 64 * MIB - 10],
      [{ size: 16 * MIB, compressedSize: 1 * MIB }, 0],
      [{ size: 0, compressedSize: 0 }, 64 * MIB],
    ] as const;

    const ours = headers.map(
      ([sizes, spent]) =>
        zipEntryRefusal(
          { name: "a", method: 8, encrypted: false, ...sizes },
          spent,
        ) ?? null,
    );
    const theirs = JSON.parse(
      exportedPython(
        `from types import SimpleNamespace
print(json.dumps([_zip_refusal(SimpleNamespace(flag_bits=0, compress_type=8, file_size=size, compress_size=packed), spent)
                  for (size, packed, spent) in json.load(sys.stdin)]))`,
        headers.map(([sizes, spent]) => [
          sizes.size,
          sizes.compressedSize,
          spent,
        ]),
      ),
    ) as unknown;

    expect(ours).toEqual([
      null,
      "past the 64 MiB read from one archive",
      null,
      null,
    ]);
    expect(theirs).toEqual(ours);
  });
});

it("charges admitted bytes across the archive and still reads empty entries", async () => {
  const archive = zipArchive([
    { name: "over-entry.txt", data: "abc", method: 0 },
    { name: "first.txt", data: "ab", method: 0 },
    { name: "fills-budget.txt", data: "cd", method: 0 },
    { name: "over-budget.txt", data: "e", method: 0 },
    { name: "empty.txt", data: "", method: 0 },
  ]);
  const policy = desktopViewPolicy({ zip_bytes: 4, zip_entry_bytes: 2 });
  expect(await sameView(archive, policy)).toMatchObject({
    entry_count: 5,
    truncated: false,
    entries: [
      {
        name: "over-entry.txt",
        sha256: null,
        view_error: "larger than the 2 bytes an entry's view reads",
      },
      { name: "first.txt", view: { lines: ["ab"] }, view_error: null },
      { name: "fills-budget.txt", view: { lines: ["cd"] }, view_error: null },
      {
        name: "over-budget.txt",
        sha256: null,
        view_error: "past the 4 bytes read from one archive",
      },
      { name: "empty.txt", size: 0, view_error: null },
    ],
  });
});

describe("zip directories in the exported module", () => {
  it("tells directories apart as zip.js does: by a final slash, a Unix mode or the MS-DOS attribute", async () => {
    const archive = zipArchive([
      { name: "a.txt", data: "a\n" },
      { name: "slash/", data: "" },
      { name: "unix", data: "", madeBy: 0x0314, external: 0o040755 * 0x10000 },
      { name: "dos", data: "", madeBy: 20, external: 0x10 },
      {
        name: "unix-file",
        data: "u\n",
        madeBy: 0x0314,
        external: 0o100644 * 0x10000,
      },
    ]);

    expect(await sameView(archive)).toMatchObject({
      entries: [{ name: "a.txt" }, { name: "unix-file" }],
      entry_count: 2,
      truncated: false,
    });
  });

  it("finds the directory through a Zip64 locator whether or not the classic end record defers to it, as zipfile does", async () => {
    const members = [
      { name: "a.txt", data: "a\n" },
      { name: "d/" },
      { name: "b.json", data: '{"b": 1}' },
    ];

    // A classic record keeping its own values once left both readers short of the directory.
    for (const sentinels of [true, false])
      expect(
        await sameView(withZip64End(zipArchive(members), sentinels)),
      ).toMatchObject({
        entries: [{ name: "a.txt" }, { name: "b.json", view: { b: 1 } }],
        entry_count: 2,
      });
  });

  it.each([false, true])(
    "follows the Zip64 locator over a fixed-size signature in opaque extension bytes (%s)",
    async (sentinels) => {
      const extension = Buffer.alloc(6 + 56);
      extension.writeUInt16LE(0xfffe, 0);
      extension.writeUInt32LE(56, 2);
      extension.writeUInt32LE(0x06064b50, 6);
      const archive = withZip64End(
        zipArchive([{ name: "notes.txt", data: "retained" }]),
        sentinels,
        extension,
      );
      const result = await sameView(archive);
      expect(result).toMatchObject({
        entry_count: 1,
        entries: [{ name: "notes.txt", view: { lines: ["retained"] } }],
        truncated: false,
      });
    },
  );

  it("retains the fixed Zip64 fallback when a prefix shifts its relative locator", async () => {
    // Keep a recognized ZIP opening for desktop format detection. Only the
    // real recorded local entry and central directory contribute to the view.
    const prefix = Buffer.from("PK\x03\x04inert prefix");
    const archive = Buffer.concat([
      prefix,
      withZip64End(zipArchive([{ name: "notes.txt", data: "retained" }])),
    ]);
    const result = await sameView(archive);
    expect(result).toMatchObject({
      entry_count: 1,
      entries: [{ name: "notes.txt", view: { lines: ["retained"] } }],
      truncated: false,
    });
  });
});

it("refuses inconsistent classic and Zip64 directory record counts", async () => {
  const classic = zipArchive([
    { name: "doc/", data: "" },
    { name: "doc/settings.json", data: '{"zoom":2}' },
  ]);
  const zip64 = withZip64End(classic);
  const classicDiskCount = Buffer.from(classic);
  classicDiskCount.writeUInt16LE(1, classicDiskCount.length - 14);
  const classicTotal = Buffer.from(classicDiskCount);
  classicTotal.writeUInt16LE(1, classicTotal.length - 12);
  const zip64DiskCount = Buffer.from(zip64);
  zip64DiskCount.writeBigUInt64LE(1n, zip64DiskCount.length - 74);
  const zip64Total = Buffer.from(zip64DiskCount);
  zip64Total.writeBigUInt64LE(1n, zip64Total.length - 66);
  const archives = [classicDiskCount, classicTotal, zip64DiskCount, zip64Total];

  const python = await pythonFileViews(saved(archives));
  expect(python).toEqual(
    archives.map(() => ({
      format: "zip",
      view: null,
      error: "not a readable zip archive",
    })),
  );
  for (const archive of archives)
    expect(await readZipView(archive)).toEqual({
      ok: false,
      error: "not a readable zip archive",
    });

  for (const archive of [classic, zip64])
    expect(await sameView(archive)).toMatchObject({
      entries: [{ name: "doc/settings.json" }],
      entry_count: 1,
    });
});

describe("ZIP directory counts and volume admission in the exported module", () => {
  it("retains the selected ZIP count at and beyond the classic sentinel", async () => {
    const path = join(
      await createTestTempDirectory("rea-zip64-count-"),
      "many.zip",
    );
    // An independent writer emits an original Zip64 archive, not a decoder-copy fixture.
    execFileSync("python3", [
      "-I",
      "-B",
      "-c",
      `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    for index in range(65536):
        archive.writestr(f"entry-{index:05d}.bin", b"ab")
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert len(archive.infolist()) == 65536`,
      path,
    ]);
    const bytes = await readFile(path);
    for (const keep of [65_535, 65_536]) {
      const policy = desktopViewPolicy({
        zip_entries: keep,
        zip_entry_bytes: 1,
      });
      const result = await readZipView(bytes, undefined, policy);
      const host = result.ok
        ? (result.value as {
            entries: { name: string }[];
            entry_count: number;
            truncated: boolean;
          })
        : null;
      const python: unknown = JSON.parse(
        exportedPython(
          `${pythonDesktopViewPolicy(policy)}
result = _view(Path(json.load(sys.stdin)))
view = result.get("view")
print(json.dumps(None if view is None else {
    "listed": len(view["entries"]), "count": view["entry_count"],
    "truncated": view["truncated"], "last": view["entries"][-1]["name"]
}))`,
          path,
        ),
      );
      expect([
        host === null
          ? null
          : {
              listed: host.entries.length,
              count: host.entry_count,
              truncated: host.truncated,
              last: host.entries.at(-1)?.name,
            },
        python,
      ]).toEqual(
        Array.from({ length: 2 }, () => ({
          listed: keep,
          count: 65_536,
          truncated: keep < 65_536,
          last: `entry-${String(keep - 1).padStart(5, "0")}.bin`,
        })),
      );
    }
  });

  it("refuses archives whose selected directory or Zip64 locator names another volume", async () => {
    const classic = zipArchive([{ name: "settings.json", data: '{"zoom":2}' }]);
    const zip64 = withZip64End(classic);
    const variants = [
      ["classic disk", classic, 22, 4, 1],
      ["classic directory disk", classic, 22, 6, 1],
      ["classic disk in Zip64", zip64, 22, 4, 1],
      ["Zip64 record disk", zip64, 98, 16, 1],
      ["Zip64 directory disk", zip64, 98, 20, 1],
      ["Zip64 locator disk", zip64, 42, 4, 1],
      ["Zip64 locator disk count", zip64, 42, 16, 2],
    ] as const;
    const archives = variants.map(([, bytes, end, field, value]) => {
      const copy = Buffer.from(bytes);
      copy.writeUInt16LE(value, copy.length - end + field);
      return copy;
    });
    const python = await pythonFileViews(saved(archives));
    for (const [index, [description]] of variants.entries()) {
      expect(await readZipView(archives[index]!), description).toEqual({
        ok: false,
        error: "not a readable zip archive",
      });
      expect(python[index], description).toEqual({
        format: "zip",
        view: null,
        error: "not a readable zip archive",
      });
    }
  });

  it("uses the Zip64 record when the classic disk numbers defer to it", async () => {
    const archive = withZip64End(
      zipArchive([{ name: "settings.json", data: '{"zoom":2}' }]),
    );
    archive.writeUInt16LE(0xffff, archive.length - 18);
    archive.writeUInt16LE(0xffff, archive.length - 16);
    expect(await sameView(archive)).toMatchObject({
      entries: [{ name: "settings.json", view: { zoom: 2 } }],
      entry_count: 1,
    });
  });

  it("keeps the classic values when bytes before the end record only look like a Zip64 locator", async () => {
    // The last name ends in a locator signature and 16 more bytes, which sit just before the end record.
    const name = `c-PK\u0006\u0007${"0".repeat(16)}`;
    const archive = zipArchive([
      { name: "a.txt", data: "a\n" },
      { name, data: "c", flags: 0x800 },
    ]);

    expect(await sameView(archive)).toMatchObject({
      entries: [{ name: "a.txt" }, { name }],
      entry_count: 2,
    });
  });

  it("lists the first 1,000 of 50,000 entries holding no more of the directory than those", async () => {
    const { file, peak } = await expectSameTrackedView(
      emptyEntriesArchive(50_000),
    );

    expect(file.view).toMatchObject({ entry_count: 50_000, truncated: true });
    expect(file.view.entries).toHaveLength(1000);
    expect(file.view.entries[0]?.name).toBe("e/0");
    expect(file.view.entries.at(-1)?.name).toBe("e/999");
    // Parsing every record before the listing limit applied traced about 25 MiB here.
    expect(peak).toBeLessThan(4 * MIB);
  });
});

describe("zip entries the exported module cannot fully read", () => {
  it("reads an entry at most a byte past its declared size, so a forged small size holds no memory", async () => {
    // 32 MiB of zeros deflate to about 32 KiB; the entry declares one byte.
    const archive = zipArchive([
      {
        name: "bomb.txt",
        data: Buffer.alloc(32 * MIB),
        declaredSize: 1,
        crc: 0,
      },
    ]);
    const { file, peak } = await expectSameTrackedView(archive);

    expect(file.view.entries[0]?.view_error).toBe(
      "its compressed data is damaged",
    );
    // Reading the stream whole before clipping it traced about 77 MiB here.
    expect(peak).toBeLessThan(4 * MIB);
  });

  it("refuses JSON and key file entries over 4 MiB before building their values, as REA does", async () => {
    const objects = `[{}${",{}".repeat(1_400_000)}]`;
    const archive = zipArchive([
      { name: "objects.json", data: objects, method: 0 },
      { name: "objects.txt", data: `${objects.slice(0, -1)}}`, method: 0 },
      {
        name: "settings.ini",
        data: `[ui]\n${"wrap=false\n".repeat(400_000)}`,
        method: 0,
      },
    ]);
    const refused = "larger than the 4 MiB limit for JSON and key file views";

    expect(await sameView(archive)).toMatchObject({
      entries: [
        { format: "json", view: null, view_error: refused },
        { format: "text", view: { line_count: 1 }, view_error: null },
        { format: "keyfile", view: null, view_error: refused },
      ],
    });
    const { peak } = await pythonPeak(
      zipArchive([{ name: "objects.json", data: objects, method: 0 }]),
    );
    // Parsing the 4,200,004-byte entry before refusing it traced about 110 MB here.
    expect(peak).toBeLessThan(4 * objects.length);
  });

  it("keeps a JSON entry nested too deeply on that entry and reads its siblings, as REA does", async () => {
    const nested = (levels: number) =>
      `${"[".repeat(levels)}${"]".repeat(levels)}`;
    const archive = zipArchive([
      { name: "Document.xml", data: "<doc/>" },
      { name: "deep.json", data: nested(1100) },
      { name: "edge.json", data: nested(501) },
    ]);

    expect(await sameView(archive)).toMatchObject({
      entries: [
        { name: "Document.xml", format: "xml", view_error: null },
        {
          name: "deep.json",
          format: "json",
          view: null,
          view_error: "nested deeper than the 500 levels a JSON view keeps",
        },
        { name: "edge.json", format: "json", view_error: null },
      ],
    });
  });
});

/** A FreeCAD document zipped as FreeCAD saves it, with a shape and a thumbnail beside it. */
const fcstd = async (version: string, end: "before" | "after") =>
  zipArchive([
    {
      name: "Document.xml",
      data: await readFile(join(FIXTURES, version, end, "Document.xml")),
    },
    {
      name: "PartShape.brp",
      data: "CASCADE Topology V1, (c) Matra-Datavision\n",
    },
    {
      name: "thumbnails/Thumbnail.png",
      data: Buffer.from([0x89, 0x50, 0]),
      method: 0,
    },
  ]);

const DOCUMENT = "/entries/[name=Document.xml]/view/root/children";
const FILE = "Documents/plate.FCStd";

/** The FreeCAD task's checks, by name: they hold in both versions' files. */
const HOLE_CHECKS: DesktopTaskCheck[] = [
  {
    id: "cut",
    kind: "value_equals",
    file: FILE,
    pointer: `${DOCUMENT}/[name=Objects]/children/[name=Object][@type=Part::Cut]/attributes/type`,
    value: "Part::Cut",
  },
  {
    id: "radius",
    kind: "value_equals",
    file: FILE,
    pointer: `${DOCUMENT}/[name=ObjectData]/children/[name=Object][@name=Hole]/children/[name=Properties]/children/[name=Property][@name=Radius]/children/[name=Float]/attributes/value`,
    value: 5,
    tolerance: 0.01,
  },
  {
    id: "tool",
    kind: "value_equals",
    file: FILE,
    pointer: `${DOCUMENT}/[name=ObjectData]/children/[name=Object][@name=PlateWithHole]/children/[name=Properties]/children/[name=Property][@name=Tool]/children/[name=Link]/attributes/value`,
    value: "Hole",
  },
];

describe("FreeCAD documents", () => {
  it.each(["0.21", "1.0"])(
    "checks the hole in FreeCAD %s by name: failing before the edit and passing after, in both evaluators",
    async (version) => {
      const archives = saved([
        await fcstd(version, "before"),
        await fcstd(version, "after"),
      ]);
      await expectSameFileViews(archives);

      const [before, after] = await expectSameCheckResults(
        FILE,
        HOLE_CHECKS,
        archives,
      );
      expect(before?.map(({ passed }) => passed)).toEqual([
        false,
        false,
        false,
      ]);
      expect(after?.map(({ passed }) => passed)).toEqual([true, true, true]);
      expect(after?.[1]?.description).toContain(
        'is "5.0000000000000000", within 0.01 of 5',
      );
    },
  );
});

describe("OpenDocument text", () => {
  it("reads content.xml from an .odt as REA does, its namespaced names included", async () => {
    const odt = odtArchive("Buy milk");
    const read = await readZipView(odt);
    const [python] = await pythonFileViews([{ name: "list.odt", bytes: odt }]);

    expect(detectStateFormat("list.odt", odt)).toBe("zip");
    expect(read.ok && read.value).toMatchObject({
      entries: [
        {
          name: "mimetype",
          format: "text",
          view: { lines: ["application/vnd.oasis.opendocument.text"] },
        },
        {
          name: "content.xml",
          format: "xml",
          view: {
            root: {
              name: "office:document-content",
              children: [
                {
                  name: "office:body",
                  children: [
                    {
                      name: "office:text",
                      children: [{ name: "text:p", children: ["Buy milk"] }],
                    },
                  ],
                },
              ],
            },
          },
        },
        { name: "META-INF/manifest.xml", format: "xml" },
      ],
    });
    expect(python?.view).toEqual(read.ok ? read.value : null);
  });
});
