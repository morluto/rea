import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import { readZipView } from "../../../src/application/desktop/DesktopZipView.js";
import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import { evaluateTaskChecks } from "../../../src/domain/desktop/appTaskChecks.js";
import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { PYTHON_TASK_EVALUATOR } from "../../../src/domain/desktop/appTaskPython.js";
import { detectStateFormat } from "../../../src/domain/desktop/stateFormats.js";
import {
  odtArchive,
  zipArchive,
  type ZipMember,
} from "../../../src/domain/desktop/zipArchive.fixture.js";
import { zipEntryRefusal } from "../../../src/domain/desktop/zipView.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const MIB = 1024 * 1024;
const FIXTURES = join(import.meta.dirname, "../../fixtures/freecad");

/** The exported module's standard library imports, its helpers and the verifier's evaluator, as one program. */
const PYTHON = `${PYTHON_IMPORTS.split("\n")
  .filter((line) => !line.includes("agentenv_protocol"))
  .join("\n")}${PYTHON_HELPERS}${PYTHON_TASK_EVALUATOR}`;

const python = (driver: string, input: unknown): string =>
  execFileSync("python3", ["-I", "-B", "-c", `${PYTHON}\n${driver}`], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 * MIB,
  });

/** Write each archive to a file, as data/get finds it under the home. */
const archiveFiles = async (archives: readonly Buffer[]) => {
  const folder = await createTestTempDirectory("desktop-zip-python-");
  return Promise.all(
    archives.map(async (bytes, index) => {
      const path = join(folder, `${String(index)}.FCStd`);
      await writeFile(path, bytes);
      return path;
    }),
  );
};

/** The exported module's data/get entry for each archive file: its format and view, or its error. */
const pythonViews = async (archives: readonly Buffer[]) =>
  python(
    `for path in json.load(sys.stdin):
    print(json.dumps(_view(Path(path))))`,
    await archiveFiles(archives),
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, JsonValue>);

/** REA's state view of an archive in the shape data/get serves it. */
const typescriptView = async (bytes: Buffer) => {
  const read = await readZipView(bytes);
  return read.ok
    ? { format: detectStateFormat("a.FCStd", bytes), view: read.value }
    : {
        format: detectStateFormat("a.FCStd", bytes),
        view: null,
        error: read.error,
      };
};

const expectSameViews = async (archives: readonly Buffer[]) => {
  const fromPython = await pythonViews(archives);
  for (const [index, bytes] of archives.entries()) {
    const ours = await typescriptView(bytes);
    const theirs = fromPython[index] ?? {};
    expect(theirs.format).toBe(ours.format);
    expect(theirs.view).toEqual(ours.view);
    expect(theirs.error).toBe(ours.error);
  }
};

const sqliteHeader = Buffer.concat([
  Buffer.from("SQLite format 3\0"),
  Buffer.alloc(84),
]);

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
      python(
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

    const measured = JSON.parse(
      python(
        `import tracemalloc
tracemalloc.start()
view = _view(Path(json.load(sys.stdin)[0]))
peak = tracemalloc.get_traced_memory()[1]
tracemalloc.stop()
print(json.dumps({"error": view["view"]["entries"][0]["view_error"], "peak": peak}))`,
        await archiveFiles([archive]),
      ),
    ) as { error: string; peak: number };

    expect(measured.error).toBe("its compressed data is damaged");
    // Reading the stream whole before clipping it traced about 77 MiB here.
    expect(measured.peak).toBeLessThan(4 * MIB);
  });

  it("keeps a JSON entry nested too deeply on that entry and reads its siblings, as REA does", async () => {
    const nested = (levels: number) =>
      `${"[".repeat(levels)}${"]".repeat(levels)}`;
    const archive = zipArchive([
      { name: "Document.xml", data: "<doc/>" },
      { name: "deep.json", data: nested(1100) },
      { name: "edge.json", data: nested(501) },
    ]);

    await expectSameViews([archive]);
    const read = await readZipView(archive);
    if (!read.ok) throw new Error(read.error);
    expect(read.value).toMatchObject({
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

/** Each archive's check results from the exported module: its own view of the file, then the verifier's evaluator. */
const pythonResults = async (archives: readonly Buffer[]) =>
  python(
    `request = json.load(sys.stdin)
for path in request["paths"]:
    print(json.dumps(evaluate(request["checks"], {${JSON.stringify(FILE)}: _view(Path(path))})))`,
    { paths: await archiveFiles(archives), checks: HOLE_CHECKS },
  )
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          id: string;
          result: boolean;
          description: string;
        }[],
    );

describe("FreeCAD documents", () => {
  it.each(["0.21", "1.0"])(
    "checks the hole in FreeCAD %s by name: failing before the edit and passing after, in both evaluators",
    async (version) => {
      const archives = [
        await fcstd(version, "before"),
        await fcstd(version, "after"),
      ];
      await expectSameViews(archives);

      const fromPython = await pythonResults(archives);
      for (const [index, bytes] of archives.entries()) {
        const ours = evaluateTaskChecks(
          HOLE_CHECKS,
          new Map([[FILE, await typescriptView(bytes)]]),
        );
        expect(ours.map(({ passed }) => passed)).toEqual(
          index === 0 ? [false, false, false] : [true, true, true],
        );
        expect(fromPython[index]).toEqual(
          ours.map(({ id, passed, description }) => ({
            id,
            result: passed,
            description,
          })),
        );
      }
      const after = evaluateTaskChecks(
        HOLE_CHECKS,
        new Map([[FILE, await typescriptView(archives[1] ?? Buffer.alloc(0))]]),
      );
      expect(after[1]?.description).toContain(
        'is "5.0000000000000000", within 0.01 of 5',
      );
    },
  );
});

describe("OpenDocument text", () => {
  it("reads content.xml from an .odt, its namespaced names the only difference between the readers", async () => {
    const odt = odtArchive("Buy milk");
    const read = await readZipView(odt);
    const [python] = await pythonViews([odt]);

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
    const strip = (view: JsonValue | undefined) =>
      (view as { entries: Record<string, JsonValue>[] }).entries.map(
        ({ view: entryView, ...entry }) =>
          entry.format === "xml" ? entry : { ...entry, view: entryView },
      );
    expect(strip(python?.view)).toEqual(strip(read.ok ? read.value : null));
    expect(JSON.stringify(python?.view)).toContain(
      "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}p",
    );
  });
});
