import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { draftTaskFiles } from "./appTaskDraft.js";
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

  it("suggests nothing inside XML that uses namespaces, which the verifier names differently", () => {
    const odt = (text: string): JsonValue => ({
      entries: [
        {
          name: "content.xml",
          size: 1,
          sha256: text,
          format: "xml",
          view: {
            root: {
              name: "office:text",
              attributes: {},
              children: [{ name: "text:p", attributes: {}, children: [text] }],
            },
            truncated: false,
          },
          view_error: null,
        },
      ],
      entry_count: 1,
      truncated: false,
    });

    const [list] = draft({
      "Documents/list.odt": path("document", "zip", odt("a"), odt("b")),
    });

    expect(list).toMatchObject({ change: { kind: "values" }, suggested: [] });
  });
});
