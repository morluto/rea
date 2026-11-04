import type { DesktopTaskCheckInput } from "./appTask.js";
import type { TaskFileView } from "./appTaskChecks.js";

/** Views of every format data/get serves, including the ones a check cannot read. */
export const CHECK_VIEWS: Readonly<Record<string, TaskFileView>> = {
  "Documents/todo.txt": {
    format: "text",
    view: {
      lines: ["buy bread", "buy milk", "buy milk", "CIRCLE", "naïve café"],
      line_count: 5,
      truncated: false,
    },
  },
  "Documents/long.txt": {
    format: "text",
    view: { lines: ["a"], line_count: 6000, truncated: true },
  },
  ".config/notes/settings.json": {
    format: "json",
    view: {
      wrap: true,
      size: 12,
      ratio: 0.5,
      zero: 0,
      tags: ["a", "b"],
      "a/b": { "~k": null },
    },
  },
  ".config/notes/app.ini": {
    format: "keyfile",
    view: { groups: { ui: { wrap: "false" } } },
  },
  ".config/notes/layout.xml": {
    format: "xml",
    view: {
      root: { name: "layout", attributes: { width: "80" }, children: [] },
      truncated: true,
    },
  },
  ".local/share/notes/notes.db": {
    format: "sqlite",
    view: {
      tables: {
        notes: {
          columns: ["id", "body", "done"],
          primary_key: ["id"],
          rows: [
            [1, "a", 0],
            [2, "b", 1],
          ],
          truncated: false,
        },
        big: { columns: ["id"], primary_key: [], rows: [[1]], truncated: true },
        broken: { error: "malformed" },
      },
      tables_truncated: false,
    },
  },
  ".local/share/notes/cut.db": {
    format: "sqlite",
    view: { tables: {}, tables_truncated: true },
  },
  "Documents/photo.png": { format: "binary", view: null },
  "Documents/huge.txt": {
    format: null,
    view: null,
    error: "larger than 64 MiB, the most the view reads",
  },
};

const todo = "Documents/todo.txt";
const settings = ".config/notes/settings.json";
const db = ".local/share/notes/notes.db";
const absent = "Documents/absent.txt";

/** Every kind of check against those views, each with the outcome both evaluators must give. */
export const CHECK_CASES: readonly (readonly [
  DesktopTaskCheckInput,
  boolean,
])[] = [
  [{ kind: "file_present", file: todo }, true],
  [{ kind: "file_present", file: absent }, false],
  [{ kind: "file_absent", file: absent }, true],
  [{ kind: "file_absent", file: "Documents/huge.txt" }, false],
  [
    { kind: "lines_present", file: todo, lines: ["buy milk", "naïve café"] },
    true,
  ],
  [{ kind: "lines_present", file: todo, lines: ["buy eggs"] }, false],
  [{ kind: "lines_present", file: absent, lines: ["x"] }, false],
  [{ kind: "lines_present", file: settings, lines: ["x"] }, false],
  [{ kind: "lines_present", file: "Documents/long.txt", lines: ["a"] }, true],
  [{ kind: "lines_absent", file: todo, lines: ["buy eggs"] }, true],
  [
    { kind: "lines_absent", file: todo, lines: ["buy eggs", "buy bread"] },
    false,
  ],
  [{ kind: "lines_absent", file: "Documents/long.txt", lines: ["z"] }, false],
  [{ kind: "lines_absent", file: absent, lines: ["x"] }, true],
  [{ kind: "lines_absent", file: "Documents/huge.txt", lines: ["x"] }, false],
  [{ kind: "line_count", file: todo, exact: "buy milk", equals: 2 }, true],
  [{ kind: "line_count", file: todo, exact: "buy milk", at_least: 3 }, false],
  [{ kind: "line_count", file: todo, exact: "buy milk", at_most: 2 }, true],
  [{ kind: "line_count", file: todo, regex: "^buy", equals: 3 }, true],
  [{ kind: "line_count", file: todo, regex: "MILK", equals: 0 }, true],
  [{ kind: "line_count", file: todo, regex: "^C.*E$", equals: 1 }, true],
  [
    { kind: "line_count", file: todo, regex: "^na.ve [a-z]+é$", equals: 1 },
    true,
  ],
  [
    { kind: "line_count", file: todo, regex: "(?:milk|bread)$", at_least: 3 },
    true,
  ],
  [
    { kind: "line_count", file: "Documents/long.txt", exact: "a", at_least: 1 },
    false,
  ],
  [{ kind: "line_count", file: absent, exact: "x", equals: 0 }, true],
  [
    { kind: "value_equals", file: settings, pointer: "/wrap", value: true },
    true,
  ],
  [{ kind: "value_equals", file: settings, pointer: "/wrap", value: 1 }, false],
  [
    { kind: "value_equals", file: settings, pointer: "/zero", value: false },
    false,
  ],
  [{ kind: "value_equals", file: settings, pointer: "/size", value: 12 }, true],
  [
    { kind: "value_equals", file: settings, pointer: "/ratio", value: 0.5 },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: settings,
      pointer: "/tags",
      value: ["a", "b"],
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: settings,
      pointer: "/tags",
      value: ["b", "a"],
    },
    false,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/tags/1", value: "b" },
    true,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/tags/01", value: "b" },
    false,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/a~1b/~0k", value: null },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: settings,
      pointer: "/a~1b",
      value: { "~k": null },
    },
    true,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/a~1b", value: {} },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: ".config/notes/app.ini",
      pointer: "/groups/ui/wrap",
      value: "false",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: db,
      pointer: "/tables/notes/rows/1/1",
      value: "b",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: ".config/notes/layout.xml",
      pointer: "/root/attributes/width",
      value: "80",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: "Documents/photo.png",
      pointer: "/x",
      value: 1,
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: "Documents/huge.txt",
      pointer: "/x",
      value: 1,
    },
    false,
  ],
  [{ kind: "value_absent", file: settings, pointer: "/missing" }, true],
  [{ kind: "value_absent", file: settings, pointer: "/tags/2" }, true],
  [{ kind: "value_absent", file: settings, pointer: "/wrap" }, false],
  [{ kind: "value_absent", file: absent, pointer: "/x" }, true],
  [
    {
      kind: "value_absent",
      file: ".config/notes/layout.xml",
      pointer: "/root/attributes/height",
    },
    false,
  ],
  [
    {
      kind: "row_present",
      file: db,
      table: "notes",
      where: { body: "b", done: 1 },
    },
    true,
  ],
  [
    {
      kind: "row_present",
      file: db,
      table: "notes",
      where: { body: "b", done: true },
    },
    false,
  ],
  [
    { kind: "row_present", file: db, table: "notes", where: { body: "c" } },
    false,
  ],
  [
    { kind: "row_present", file: db, table: "notes", where: { colour: "red" } },
    false,
  ],
  [{ kind: "row_present", file: db, table: "broken", where: { id: 1 } }, false],
  [{ kind: "row_present", file: db, table: "big", where: { id: 1 } }, true],
  [
    {
      kind: "row_present",
      file: ".local/share/notes/cut.db",
      table: "notes",
      where: { id: 1 },
    },
    false,
  ],
  [
    { kind: "row_present", file: todo, table: "notes", where: { id: 1 } },
    false,
  ],
  [
    { kind: "row_absent", file: db, table: "notes", where: { body: "c" } },
    true,
  ],
  [{ kind: "row_absent", file: db, table: "notes", where: { id: 1 } }, false],
  [{ kind: "row_absent", file: db, table: "big", where: { id: 9 } }, false],
  [{ kind: "row_absent", file: db, table: "gone", where: { id: 1 } }, true],
  [
    { kind: "row_absent", file: absent, table: "notes", where: { id: 1 } },
    true,
  ],
  [{ kind: "row_count", file: db, table: "notes", equals: 2 }, true],
  [
    {
      kind: "row_count",
      file: db,
      table: "notes",
      where: { done: 1 },
      equals: 1,
    },
    true,
  ],
  [{ kind: "row_count", file: db, table: "notes", at_least: 3 }, false],
  [{ kind: "row_count", file: db, table: "big", at_least: 1 }, false],
  [{ kind: "row_count", file: absent, table: "notes", equals: 0 }, true],
];
