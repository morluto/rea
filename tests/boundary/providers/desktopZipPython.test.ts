import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";
import { ZipReader, Uint8ArrayReader, TextWriter } from "@zip.js/zip.js";

import { readZipView } from "../../../src/application/desktop/DesktopZipView.js";
import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { detectStateFormat } from "../../../src/domain/desktop/stateFormats.js";
import {
  emptyEntriesArchive,
  odtArchive,
  withZip64End,
  zipArchive,
  type ZipMember,
} from "../../../src/domain/desktop/zipArchive.fixture.js";
import { zipEntryRefusal } from "../../../src/domain/desktop/zipView.js";
import {
  expectSameCheckResults,
  expectSameFileViews,
  exportedPython,
  pythonFileViews,
  writeFiles,
} from "../../support/desktopExportPython.js";

const MIB = 1024 * 1024;
const FIXTURES = join(import.meta.dirname, "../../fixtures/freecad");

/** Archives as FreeCAD documents under the home. */
const saved = (archives: readonly Buffer[]) =>
  archives.map((bytes) => ({ name: "plate.FCStd", bytes }));

const expectSameViews = (archives: readonly Buffer[]) =>
  expectSameFileViews(saved(archives));

/** REA's view of an archive, once the exported module's is shown to be the same. */
const sameView = async (archive: Buffer) => {
  await expectSameViews([archive]);
  const read = await readZipView(archive);
  if (!read.ok) throw new Error(read.error);
  return read.value;
};

/** The exported module's zip view of an archive file, and the most memory reading it traced. */
const pythonPeak = async (archive: Buffer) =>
  JSON.parse(
    exportedPython(
      `import tracemalloc
tracemalloc.start()
view = _view(Path(json.load(sys.stdin)[0]))["view"]
peak = tracemalloc.get_traced_memory()[1]
tracemalloc.stop()
print(json.dumps({"view": view, "peak": peak}))`,
      await writeFiles(saved([archive])),
    ),
  ) as {
    view: { entries: Record<string, JsonValue>[]; entry_count: number };
    peak: number;
  };

const sqliteHeader = Buffer.concat([
  Buffer.from("SQLite format 3\0"),
  Buffer.alloc(84),
]);

it("gives the UTF-8 flag precedence over a Unicode Path for names and formats", async () => {
  const storedName = "legacy.txt";
  const unicodeName = Buffer.from("café.json");
  const extra = Buffer.alloc(9 + unicodeName.length);
  extra.writeUInt16LE(0x7075);
  extra.writeUInt16LE(extra.length - 4, 2);
  extra[4] = 1;
  extra.writeUInt32LE(crc32(Buffer.from(storedName)), 5);
  unicodeName.copy(extra, 9);
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

    await expectSameViews([zipArchive(members)]);
    const read = await readZipView(zipArchive(members));
    expect(read).toMatchObject({
      ok: true,
      value: { entry_count: 9, truncated: false },
    });
    if (!read.ok) return;
    expect(read.value).toMatchObject({
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

    await expectSameViews([archive, damaged]);
    const read = await readZipView(archive);
    expect(read.ok && read.value).toMatchObject({
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
    expect(await readZipView(damaged)).toEqual({
      ok: false,
      error: "not a readable zip archive",
    });
  });

  it("lists at most 1,000 entries and counts the rest", async () => {
    const archive = zipArchive(
      Array.from({ length: 1002 }, (_, index) => ({
        name: `n/${String(index)}.txt`,
        data: String(index),
        method: 0,
      })),
    );

    await expectSameViews([archive]);
    const read = await readZipView(archive);
    expect(read.ok && read.value).toMatchObject({
      entry_count: 1002,
      truncated: true,
    });
    expect(
      read.ok && (read.value as { entries: unknown[] }).entries,
    ).toHaveLength(1000);
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

  it.for([
    { name: "deferred", sentinels: true, shadow: false },
    { name: "classic", sentinels: false, shadow: false },
    { name: "deferred shadow", sentinels: true, shadow: true },
    { name: "classic shadow", sentinels: false, shadow: true },
  ])(
    "reads the located Zip64 extensible record ($name)",
    async ({ sentinels, shadow }) => {
      const payload = Buffer.alloc(shadow ? 88 : 1, 0);
      if (shadow) payload.writeUInt32LE(0x06064b50, payload.length - 56);
      const extension = Buffer.alloc(6 + payload.length);
      extension.writeUInt16LE(0xcafe, 0);
      extension.writeUInt32LE(payload.length, 2);
      extension.set(payload, 6);
      const archive = withZip64End(
        zipArchive([
          { name: "settings.json", data: '{"zoom":1}\n', method: 0 },
        ]),
        sentinels,
        extension,
      );
      // The unwrapped library reads this valid frame, independently of our
      // bounded directory rewrite and the exported standard-library reader.
      const reader = new ZipReader(new Uint8ArrayReader(archive), {
        useWebWorkers: false,
      });
      try {
        const entries = await reader.getEntries();
        expect(entries.map((entry) => entry.filename)).toEqual([
          "settings.json",
        ]);
        const entry = entries[0];
        if (entry === undefined || entry.directory)
          throw new Error("The control archive must contain one file");
        expect(
          await entry.getData(new TextWriter(), {
            checkSignature: true,
          }),
        ).toBe('{"zoom":1}\n');
      } finally {
        await reader.close();
      }
      const read = await readZipView(archive);
      const [python] = await pythonFileViews(saved([archive]));
      const view = {
        entries: [
          {
            name: "settings.json",
            format: "json",
            view: { zoom: 1 },
            view_error: null,
          },
        ],
        entry_count: 1,
        truncated: false,
      };
      expect.soft(read).toMatchObject({ ok: true, value: view });
      expect
        .soft(python)
        .toMatchObject({ format: "zip", view, truncated: false });
    },
  );

  it("rejects a Zip64 frame size that does not reach its locator", async () => {
    const bytes = withZip64End(zipArchive([{ name: "a.txt", data: "a" }]));
    const record = bytes.length - 22 - 20 - 56;
    for (const size of [43n, 45n, 0xffffffffffffffffn]) {
      const malformed = Buffer.from(bytes);
      malformed.writeBigUInt64LE(size, record + 4);
      expect(await readZipView(malformed)).toEqual({
        ok: false,
        error: "not a readable zip archive",
      });
      expect(await pythonFileViews(saved([malformed]))).toMatchObject([
        { format: "zip", view: null, error: "not a readable zip archive" },
      ]);
    }
  });

  it("keeps the fixed-record fallback when the declared Zip64 pointer is unusable", async () => {
    const archive = withZip64End(zipArchive([{ name: "a.txt", data: "a" }]));
    archive.writeBigUInt64LE(0xffffffffffffffffn, archive.length - 22 - 20 + 8);
    expect(await sameView(archive)).toMatchObject({
      entry_count: 1,
      entries: [{ name: "a.txt" }],
    });
  });

  it("lists the first 1,000 of 50,000 entries holding no more of the directory than those", async () => {
    const archive = emptyEntriesArchive(50_000);
    await expectSameViews([archive]);

    const { view, peak } = await pythonPeak(archive);

    expect(view.entries).toHaveLength(1000);
    expect(view.entry_count).toBe(50_000);
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
    await expectSameViews([archive]);

    const { view, peak } = await pythonPeak(archive);

    expect(view.entries[0]?.view_error).toBe("its compressed data is damaged");
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
  }, 60_000);

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
