import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { draftTaskFiles } from "./appTaskDraft.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";
import type { DesktopStatePath } from "./desktopState.js";

type Format = DesktopStatePath["format"];

const version = (
  index: number,
  format: Format,
  view: JsonValue | null,
  sha256: string | null = `${String(index)}`.repeat(64).slice(0, 64),
) => ({
  checkpoint_index: index,
  checkpoint: index === 0 ? "baseline" : "saved",
  present: view !== null,
  sha256: view === null ? null : sha256,
  format: view === null ? null : format,
  view,
  view_error: null,
});

const path = (
  role: DesktopStatePath["role"],
  format: Format,
  before: JsonValue | null,
  after: JsonValue | null,
): DesktopStatePath => ({
  path: "/home/ada/x",
  home_path: "x",
  role,
  reasons: [],
  format,
  versions: [version(0, format, before), version(1, format, after)],
  changes: [],
});

const text = (...lines: string[]) => ({
  lines,
  line_count: lines.length,
  truncated: false,
});

const draft = (files: Record<string, DesktopStatePath>) =>
  draftTaskFiles(
    new Map(Object.entries(files)),
    (home) => home !== "elsewhere",
    { seed: 0, end: 1 },
  );

describe("draftTaskFiles", () => {
  it("suggests the lines a document gained and lost, and leaves the app's state without views", () => {
    const [state, document] = draft({
      "Documents/todo.txt": path(
        "document",
        "text",
        text("buy bread"),
        text("buy milk"),
      ),
      ".config/app/state.txt": path(
        "application_state",
        "text",
        text("a"),
        text("b"),
      ),
      elsewhere: path("document", "text", text("a"), text("b")),
    });

    expect(document).toMatchObject({
      file: "Documents/todo.txt",
      change: { kind: "lines", added: ["buy milk"], removed: ["buy bread"] },
      suggested: [
        {
          kind: "lines_present",
          file: "Documents/todo.txt",
          lines: ["buy milk"],
        },
        {
          kind: "lines_absent",
          file: "Documents/todo.txt",
          lines: ["buy bread"],
        },
      ],
    });
    expect(state?.suggested).toEqual([]);
    expect(state?.final).not.toHaveProperty("view");
  });

  it("suggests counts of worded lines when a rewrite adds too many lines to list", () => {
    const before = ["0", "CIRCLE", "0", "CIRCLE"];
    const after = [
      ...Array.from({ length: 20 }, (_, index) => `  ${String(index)}`),
      "0",
      "CIRCLE",
      "CIRCLE",
      "CIRCLE",
    ];
    const [plate] = draft({
      "Documents/plate.dxf": path(
        "document",
        "text",
        text(...before),
        text(...after),
      ),
    });

    expect(plate?.suggested).toEqual([
      {
        kind: "line_count",
        file: "Documents/plate.dxf",
        exact: "CIRCLE",
        equals: 3,
      },
    ]);
    expect(plate?.change).toMatchObject({
      line_counts: [
        { line: "0", baseline: 2, final: 1 },
        { line: "CIRCLE", baseline: 2, final: 3 },
      ],
    });
  });
});

describe("draftTaskFiles for structured views", () => {
  it("suggests key file values by pointer, leaving out times the app stamps", () => {
    const [settings] = draft({
      ".config/app/app.ini": path(
        "application_state",
        "keyfile",
        { groups: { "ui/main": { wrap: "false", old: "1" } } },
        {
          groups: {
            "ui/main": { wrap: "true", saved: "2026-11-04T10:00:00Z" },
          },
        },
      ),
    });

    expect(settings?.suggested).toEqual([
      {
        kind: "value_equals",
        file: ".config/app/app.ini",
        pointer: "/groups/ui~1main/wrap",
        value: "true",
      },
      {
        kind: "value_absent",
        file: ".config/app/app.ini",
        pointer: "/groups/ui~1main/old",
      },
    ]);
  });

  it("finds a key holding / and suggests an added JSON container through its members", () => {
    const [settings, document] = draft({
      ".config/app/app.ini": path(
        "application_state",
        "keyfile",
        { groups: { ui: { "size/w": "1" } } },
        { groups: { ui: { "size/w": "2" } } },
      ),
      ".config/app/state.json": path(
        "application_state",
        "json",
        {},
        { recent: [{ name: "a.txt" }], items: [] },
      ),
    });

    expect(settings?.suggested).toEqual([
      {
        kind: "value_equals",
        file: ".config/app/app.ini",
        pointer: "/groups/ui/size~1w",
        value: "2",
      },
    ]);
    expect(document?.suggested).toEqual([
      {
        kind: "value_equals",
        file: ".config/app/state.json",
        pointer: "/recent/0/name",
        value: "a.txt",
      },
      {
        kind: "value_equals",
        file: ".config/app/state.json",
        pointer: "/items",
        value: [],
      },
    ]);
  });

  it("suggests rows added, changed and removed, and the new row count", () => {
    const table = (rows: JsonValue[][]) => ({
      tables: {
        notes: {
          columns: ["id", "body", "done", "at"],
          primary_key: ["id"],
          rows,
          truncated: false,
        },
      },
      tables_truncated: false,
    });
    const [database] = draft({
      ".local/share/app/notes.db": path(
        "application_state",
        "sqlite",
        table([
          [1, "a", 0, "2026-11-04 09:00:00"],
          [2, "b", 0, "2026-11-04 09:00:00"],
          [3, "c", 0, "2026-11-04 09:00:00"],
        ]),
        table([
          [1, "a", 1, "2026-11-04 10:00:00"],
          [3, "c", 0, "2026-11-04 09:00:00"],
          [4, "d", 0, "2026-11-04 10:00:00"],
          [5, "e", 0, "2026-11-04 10:00:00"],
        ]),
      ),
    });
    const file = ".local/share/app/notes.db";

    expect(database?.suggested).toEqual([
      { kind: "row_present", file, table: "notes", where: { id: 1, done: 1 } },
      {
        kind: "row_present",
        file,
        table: "notes",
        where: { body: "d", done: 0 },
      },
      {
        kind: "row_present",
        file,
        table: "notes",
        where: { body: "e", done: 0 },
      },
      { kind: "row_absent", file, table: "notes", where: { id: 2 } },
      { kind: "row_count", file, table: "notes", equals: 4 },
    ]);
  });

  it("suggests a created file's presence and a deleted file's absence, and skips files that end as they began", () => {
    const same = path("document", "text", text("a"), text("a"));
    same.versions[1] = {
      ...same.versions[1]!,
      sha256: same.versions[0]!.sha256,
    };
    const files = draft({
      "Documents/new.txt": path("document", "text", null, text("milk")),
      "Documents/old.txt": path("document", "text", text("x"), null),
      "Documents/same.txt": same,
    });

    expect(files.map(({ file, suggested }) => [file, suggested])).toEqual([
      [
        "Documents/new.txt",
        [
          { kind: "file_present", file: "Documents/new.txt" },
          { kind: "lines_present", file: "Documents/new.txt", lines: ["milk"] },
        ],
      ],
      [
        "Documents/old.txt",
        [{ kind: "file_absent", file: "Documents/old.txt" }],
      ],
    ]);
  });
});

describe("draftTaskFiles for XML that uses namespaces", () => {
  it("suggests values inside an XML file by pointer, as for any XML", () => {
    const poster = (headline: string): JsonValue => ({
      root: {
        name: "svg",
        attributes: {
          xmlns: "http://www.w3.org/2000/svg",
          "sodipodi:docname": "poster.svg",
        },
        children: [
          {
            name: "text",
            attributes: { id: "headline" },
            children: [headline],
          },
        ],
      },
      truncated: false,
    });

    const [document] = draft({
      "Pictures/poster.svg": path(
        "document",
        "xml",
        poster("Spring Bake Sale"),
        poster("Summer Bake Sale"),
      ),
    });

    expect(document?.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Pictures/poster.svg",
        pointer: "/root/children/0/children/0",
        value: "Summer Bake Sale",
      },
    ]);
  });
});

describe("draftTaskFiles with nullable SQLite keys", () => {
  it("suggests checks for distinct NULL-key rows and ignores a reorder", () => {
    const file = ".local/share/app/items.db";
    const table = (rows: (string | null)[][]) => ({
      tables: {
        items: {
          columns: ["id", "body"],
          primary_key: ["id"],
          rows,
          truncated: false,
        },
      },
      tables_truncated: false,
    });
    expect(
      draft({
        [file]: path(
          "application_state",
          "sqlite",
          table([
            [null, "alpha"],
            [null, "beta"],
          ]),
          table([
            [null, "beta"],
            [null, "alpha"],
          ]),
        ),
      }),
    ).toEqual([]);
    const [database] = draft({
      [file]: path(
        "application_state",
        "sqlite",
        table([
          [null, "alpha"],
          [null, "beta"],
        ]),
        table([
          [null, "gamma"],
          [null, "beta"],
        ]),
      ),
    });
    expect(database?.suggested).toEqual([
      {
        kind: "row_present",
        file,
        table: "items",
        where: { id: null, body: "gamma" },
      },
      {
        kind: "row_absent",
        file,
        table: "items",
        where: { id: null, body: "alpha" },
      },
    ]);
  });
});

describe("draftTaskFiles with unkeyed row conditions", () => {
  const file = "Documents/items.db";
  const table = (rows: JsonValue[][]) => ({
    tables: {
      items: {
        columns: ["id", "body", "at"],
        primary_key: ["id"],
        rows,
        truncated: false,
      },
    },
    tables_truncated: false,
  });

  it("does not contradict itself when only a NULL-key row timestamp changes", () => {
    const [database] = draft({
      [file]: path(
        "document",
        "sqlite",
        table([[null, "alpha", "2026-11-04 09:00:00"]]),
        table([[null, "alpha", "2026-11-04 10:00:00"]]),
      ),
    });
    expect(database?.suggested).toEqual([]);
  });

  it("counts repeated row conditions even when the total row count stays equal", () => {
    const before = table([
      [null, "alpha", null],
      [null, "alpha", null],
      [null, "beta", null],
    ]);
    const after = table([
      [null, "alpha", null],
      [null, "beta", null],
      [null, "beta", null],
    ]);
    const [database] = draft({
      [file]: path("document", "sqlite", before, after),
    });
    expect(database?.suggested).toEqual([
      {
        kind: "row_count",
        file,
        table: "items",
        where: { id: null, body: "alpha", at: null },
        equals: 1,
      },
      {
        kind: "row_count",
        file,
        table: "items",
        where: { id: null, body: "beta", at: null },
        equals: 2,
      },
    ]);
    const checks = (database?.suggested ?? []).map((check, index) => ({
      ...check,
      id: String(index),
    }));
    expect(
      evaluateTaskChecks(
        checks,
        new Map([[file, { format: "sqlite", view: after }]]),
      ).map((outcome) => outcome.passed),
    ).toEqual([true, true]);
    expect(
      evaluateTaskChecks(
        checks,
        new Map([[file, { format: "sqlite", view: before }]]),
      ).map((outcome) => outcome.passed),
    ).toEqual([false, false]);
  });

  it.each([
    {
      name: "counts all rows matching an overlapping predicate",
      before: [
        [null, "alpha", "2026-11-04 09:00:00"],
        [null, "alpha", null],
      ],
      after: [
        [null, "alpha", "2026-11-04 09:00:00"],
        [null, "alpha", null],
        [null, "alpha", "2026-11-04 10:00:00"],
      ],
      expected: [
        { kind: "row_count", where: { id: null, body: "alpha" }, equals: 3 },
        { kind: "row_count", equals: 3 },
      ],
    },
    {
      name: "does not suggest absence when a broader predicate still matches",
      before: [
        [null, "alpha", "2026-11-04 09:00:00"],
        [null, "alpha", null],
      ],
      after: [[null, "alpha", null]],
      expected: [
        { kind: "row_count", where: { id: null, body: "alpha" }, equals: 1 },
        { kind: "row_count", equals: 1 },
      ],
    },
    {
      name: "keeps the surviving broad predicate when a timestamp becomes NULL",
      before: [[null, "alpha", "2026-11-04 09:00:00"]],
      after: [[null, "alpha", null]],
      expected: [
        { kind: "row_present", where: { id: null, body: "alpha", at: null } },
      ],
    },
  ])("$name", ({ before, after, expected }) => {
    for (const key of [["id"], []]) {
      const baseline = table(before);
      const final = table(after);
      baseline.tables.items.primary_key = key;
      final.tables.items.primary_key = key;
      const [database] = draft({
        [file]: path("document", "sqlite", baseline, final),
      });
      expect(database?.suggested).toEqual(
        expected.map((check) => ({ ...check, file, table: "items" })),
      );
      const checks = (database?.suggested ?? []).map((check, index) => ({
        ...check,
        id: String(index),
      }));
      for (const [view, passed] of [
        [final, true],
        [baseline, false],
      ] as const)
        expect(
          evaluateTaskChecks(
            checks,
            new Map([[file, { format: "sqlite", view }]]),
          ).map((outcome) => outcome.passed),
        ).toEqual(checks.map(() => passed));
    }
  });
});

describe("draftTaskFiles with partial evidence", () => {
  const notes = (...rows: JsonValue[][]) => ({
    tables: {
      notes: {
        columns: ["id", "body"],
        primary_key: ["id"],
        rows,
        truncated: false,
      },
    },
    tables_truncated: false,
  });

  it("lists a database whose rows changed in its sidecar while its own hash stayed", () => {
    const same = "a".repeat(64);
    const [database] = draft({
      "Documents/notes.db": {
        ...path("document", "sqlite", null, null),
        versions: [
          version(0, "sqlite", notes([1, "a"]), same),
          version(1, "sqlite", notes([1, "a"], [2, "b"]), same),
        ],
      },
    });

    expect(database).toMatchObject({
      file: "Documents/notes.db",
      change: { kind: "rows", added_count: 1 },
    });
  });

  it("leaves out a database with one version, so a changed state file keeps its suggestions", () => {
    const cut = {
      tables: {
        notes: {
          columns: ["id"],
          primary_key: ["id"],
          rows: [[1]],
          truncated: true,
        },
      },
      tables_truncated: false,
    };
    const files = draft({
      "Documents/notes.db": {
        ...path("document", "sqlite", null, null),
        versions: [version(0, "sqlite", cut)],
      },
      ".config/app/state.txt": path(
        "application_state",
        "text",
        text("a"),
        text("b"),
      ),
    });

    expect(files).toMatchObject([
      {
        file: ".config/app/state.txt",
        suggested: [
          { kind: "lines_present", lines: ["b"] },
          { kind: "lines_absent", lines: ["a"] },
        ],
      },
    ]);
  });

  it("lists a file whose views match only because both leave its change out", () => {
    const cut = { lines: ["a"], line_count: 6000, truncated: true };
    const [long] = draft({
      "Documents/long.txt": path("document", "text", cut, cut),
    });

    expect(long).toMatchObject({
      file: "Documents/long.txt",
      change: { kind: "content" },
      suggested: [],
    });
  });
});

/** An element of REA's XML view. */
const xmlElement = (
  name: string,
  attributes: Record<string, string> = {},
  children: JsonValue[] = [],
): JsonValue => ({ name, attributes, children });

/** A zip view's entry, read, under a name. */
const zipEntry = (
  name: string,
  format: string,
  view: JsonValue,
): JsonValue => ({
  name,
  size: 1,
  sha256: name,
  format,
  view,
  view_error: null,
});

const listing = (entries: JsonValue[]): JsonValue => ({
  entries,
  entry_count: entries.length,
  truncated: false,
});

describe("draftTaskFiles archives added to whole", () => {
  it("suggests checks inside a JSON value or a readable entry added whole", () => {
    const [file] = draft({
      "Documents/a.zip": path(
        "document",
        "zip",
        listing([zipEntry("a.json", "json", { a: 1 })]),
        listing([
          zipEntry("a.json", "json", { a: 1, added: { x: 1 } }),
          zipEntry("new.json", "json", { y: [2] }),
          zipEntry("new.xml", "xml", {
            root: xmlElement("doc"),
            truncated: false,
          }),
          zipEntry("new.png", "binary", null),
        ]),
      ),
    });

    expect(file?.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Documents/a.zip",
        pointer: "/entries/[name=new.xml]/view/root/name",
        value: "doc",
      },
      {
        kind: "value_equals",
        file: "Documents/a.zip",
        pointer: "/entries/[name=a.json]/view/added/x",
        value: 1,
      },
      {
        kind: "value_equals",
        file: "Documents/a.zip",
        pointer: "/entries/[name=new.json]/view/y/0",
        value: 2,
      },
    ]);
  });

  it("checks an empty array or object added as a value, and nothing absent that a type change keeps", () => {
    const [file] = draft({
      "Documents/a.zip": path(
        "document",
        "zip",
        listing([zipEntry("a.json", "json", { a: 1, kept: [1] })]),
        listing([
          zipEntry("a.json", "json", {
            a: 1,
            kept: { "0": 1 },
            items: [],
            meta: {},
          }),
        ]),
      ),
    });

    expect(file?.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Documents/a.zip",
        pointer: "/entries/[name=a.json]/view/items",
        value: [],
      },
      {
        kind: "value_equals",
        file: "Documents/a.zip",
        pointer: "/entries/[name=a.json]/view/meta",
        value: {},
      },
    ]);
  });

  it("suggests no element by its position, even at the last step", () => {
    const page = (paragraphs: string[]) =>
      listing([
        zipEntry("page.xml", "xml", {
          root: xmlElement(
            "page",
            {},
            paragraphs.map((text) => xmlElement("p", {}, [text])),
          ),
          truncated: false,
        }),
      ]);

    const [file] = draft({
      "Documents/page.zip": path(
        "document",
        "zip",
        page(["a"]),
        page(["a", "b"]),
      ),
    });

    expect(file).toMatchObject({ change: { kind: "values" }, suggested: [] });
  });
});

describe("draftTaskFiles archive elements by identity", () => {
  it("checks an element replaced by another of its type as one added and one gone, not renamed", () => {
    const document = (name: string, id: string) =>
      listing([
        zipEntry("Document.xml", "xml", {
          root: xmlElement("Objects", {}, [
            xmlElement("Object", { type: "Part::Box", name: "Plate" }),
            xmlElement("Object", { type: "Part::Cylinder", name, id }),
          ]),
          truncated: false,
        }),
      ]);

    const [file] = draft({
      "Documents/plate.zip": path(
        "document",
        "zip",
        document("Hole", "2"),
        document("Hole001", "3"),
      ),
    });

    const objects = "/entries/[name=Document.xml]/view/root/children";
    expect(file?.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Documents/plate.zip",
        pointer: `${objects}/[name=Object][@name=Hole001]/name`,
        value: "Object",
      },
      {
        kind: "value_absent",
        file: "Documents/plate.zip",
        pointer: `${objects}/[name=Object][@name=Hole]`,
      },
    ]);
  });

  it("checks an edit to an element its identifier still names, not a replacement", () => {
    const list = (color: string) =>
      listing([
        zipEntry("list.xml", "xml", {
          root: xmlElement("list", {}, [
            xmlElement("item", { color, id: "1" }),
            xmlElement("item", { id: "2" }),
          ]),
          truncated: false,
        }),
      ]);

    const [file] = draft({
      "Documents/list.zip": path("document", "zip", list("red"), list("green")),
    });

    expect(file?.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Documents/list.zip",
        pointer:
          "/entries/[name=list.xml]/view/root/children/[name=item][@id=1]/attributes/color",
        value: "green",
      },
    ]);
  });
});

/** The checks drafted for `list.xml` in an archive whose `item` elements change. */
const itemChecks = (before: JsonValue[], after: JsonValue[]) => {
  const list = (items: JsonValue[]) =>
    listing([
      zipEntry("list.xml", "xml", {
        root: xmlElement("list", {}, items),
        truncated: false,
      }),
    ]);
  const [file] = draft({
    "Documents/list.zip": path("document", "zip", list(before), list(after)),
  });
  return file?.suggested;
};

const ITEMS = "/entries/[name=list.xml]/view/root/children";

describe("draftTaskFiles archive elements beside identified ones", () => {
  it("counts an identified element's other attributes, so a selector it shares is not taken for absent", () => {
    expect(
      itemChecks(
        [
          xmlElement("item", { id: "1", color: "red" }),
          xmlElement("item", { color: "blue" }),
        ],
        [
          xmlElement("item", { id: "1", color: "blue" }),
          xmlElement("item", { color: "red" }),
        ],
      ),
    ).toEqual([
      {
        kind: "value_equals",
        file: "Documents/list.zip",
        pointer: `${ITEMS}/[name=item][@id=1]/attributes/color`,
        value: "blue",
      },
    ]);
  });

  it("keys an element by a selector naming it alone, not one an identified sibling also matches", () => {
    const body = (text: string) =>
      xmlElement("item", { color: "red", role: "body" }, [text]);
    const id = xmlElement("item", { id: "1", color: "red" });

    expect(itemChecks([id, body("old")], [id, body("new")])).toEqual([
      {
        kind: "value_equals",
        file: "Documents/list.zip",
        pointer: `${ITEMS}/[name=item][@role=body]/children/0`,
        value: "new",
      },
    ]);
  });

  it("passes over a selector an identified sibling shares for one naming the element alone", () => {
    const second = (color: string) =>
      xmlElement("item", { class: "common", role: "second", color });
    const id = xmlElement("item", { id: "1", class: "common" });

    expect(itemChecks([id, second("red")], [id, second("blue")])).toEqual([
      {
        kind: "value_equals",
        file: "Documents/list.zip",
        pointer: `${ITEMS}/[name=item][@role=second]/attributes/color`,
        value: "blue",
      },
    ]);
  });
});

describe("draftTaskFiles archive entries without a view, and type changes", () => {
  it("checks no entry whose view could not be read, though JSON null is a value", () => {
    const [file] = draft({
      "Documents/a.zip": path(
        "document",
        "zip",
        listing([]),
        listing([
          {
            name: "big.json",
            size: 1,
            sha256: "big.json",
            format: "json",
            view: null,
            view_error:
              "a number in it cannot be read exactly, such as an integer above 2^53",
          },
          zipEntry("null.json", "json", null),
        ]),
      ),
    });

    expect(file?.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Documents/a.zip",
        pointer: "/entries/[name=null.json]/view",
        value: null,
      },
    ]);
  });

  it("suggests no absence inside an entry that ends with no view, such as one now binary", () => {
    const [file] = draft({
      "Documents/a.zip": path(
        "document",
        "zip",
        listing([zipEntry("a.json", "json", { a: 1 })]),
        listing([zipEntry("a.json", "binary", null)]),
      ),
    });

    expect(file).toMatchObject({ change: { kind: "values" }, suggested: [] });
  });

  it("suggests no absence of a value a selector still names after a type change", () => {
    const [file] = draft({
      "Documents/a.zip": path(
        "document",
        "zip",
        listing([zipEntry("a.json", "json", { items: { "[name=x]": 1 } })]),
        listing([zipEntry("a.json", "json", { items: [{ name: "x" }] })]),
      ),
    });

    expect(file?.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Documents/a.zip",
        pointer: "/entries/[name=a.json]/view/items/[name=x]/name",
        value: "x",
      },
    ]);
  });
});

describe("draftTaskFiles archives", () => {
  it("suggests checks inside an archive's XML by name: elements added or removed whole, then values", () => {
    const element = (
      name: string,
      attributes: Record<string, string>,
      children: JsonValue[] = [],
    ): JsonValue => ({ name, attributes, children });
    const archive = (objects: JsonValue[], saved: string): JsonValue => ({
      entries: [
        {
          name: "Document.xml",
          size: 1,
          sha256: saved,
          format: "xml",
          view: {
            root: element("Document", { saved }, [
              element("Objects", {}, objects),
            ]),
            truncated: false,
          },
          view_error: null,
        },
        {
          name: "thumb.png",
          size: 1,
          sha256: saved,
          format: "binary",
          view: null,
          view_error: null,
        },
      ],
      entry_count: 2,
      truncated: false,
    });
    const plate = { name: "Plate", type: "Part::Box" };
    const box = element("Object", { ...plate, count: "1" });
    const sketch = element("Object", { name: "Sketch", type: "Sketcher" });
    const hole = element("Object", { name: "Hole", type: "Part::Cylinder" }, [
      element("Property", { name: "Radius" }, [
        element("Float", { value: "5.0" }),
      ]),
    ]);

    const [document] = draft({
      "Documents/plate.FCStd": path(
        "document",
        "zip",
        archive([box, sketch], "2026-11-04T10:12:00Z"),
        archive(
          [element("Object", { ...plate, count: "2" }), hole],
          "2026-11-04T10:13:00Z",
        ),
      ),
    });

    const objects =
      "/entries/[name=Document.xml]/view/root/children/[name=Objects]/children";
    expect(document?.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Documents/plate.FCStd",
        pointer: `${objects}/[name=Object][@name=Hole]/name`,
        value: "Object",
      },
      {
        kind: "value_absent",
        file: "Documents/plate.FCStd",
        pointer: `${objects}/[name=Object][@name=Sketch]`,
      },
      {
        kind: "value_equals",
        file: "Documents/plate.FCStd",
        pointer: `${objects}/[name=Object][@name=Plate]/attributes/count`,
        value: "2",
      },
    ]);
  });

  it("suggests checks inside XML that uses namespaces, by its prefixed names", () => {
    const paragraph = (style: string, text: string): JsonValue => ({
      name: "text:p",
      attributes: { "text:style-name": style },
      children: [text],
    });
    const odt = (date: string): JsonValue => ({
      entries: [
        {
          name: "content.xml",
          size: 1,
          sha256: date,
          format: "xml",
          view: {
            root: {
              name: "office:text",
              attributes: {
                "xmlns:text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
              },
              children: [
                paragraph("Title", "Summer Bake Sale"),
                paragraph("Subtitle", date),
              ],
            },
            truncated: false,
          },
          view_error: null,
        },
      ],
      entry_count: 1,
      truncated: false,
    });

    const [flyer] = draft({
      "Documents/flyer.odt": path(
        "document",
        "zip",
        odt("Monday 17 November"),
        odt("Monday 24 November"),
      ),
    });

    expect(flyer?.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Documents/flyer.odt",
        pointer:
          "/entries/[name=content.xml]/view/root/children/[name=text:p][@text:style-name=Subtitle]/children/0",
        value: "Monday 24 November",
      },
    ]);
  });
});
