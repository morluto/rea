import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { diffStateViews } from "./stateChanges.js";

describe("diffStateViews", () => {
  it("reports added and removed lines as a multiset", () => {
    const difference = diffStateViews(
      "text",
      { lines: ["milk", "eggs", "eggs"] },
      { lines: ["milk", "eggs", "coffee"] },
    );
    expect(difference).toMatchObject({
      kind: "lines",
      added: ["coffee"],
      removed: ["eggs"],
    });
  });

  it("reports JSON values by pointer", () => {
    expect(
      diffStateViews(
        "json",
        { theme: "light", "a/b": 1, list: [1] },
        { theme: "dark", list: [1, 2] },
      ),
    ).toMatchObject({
      kind: "values",
      added: ["/list/1"],
      removed: ["/a~1b"],
      changed: ["/theme"],
    });
  });

  it("reports key file and dconf keys as group/key", () => {
    expect(
      diffStateViews(
        "dconf",
        { groups: { "org/app": { wrap: "false" } } },
        { groups: { "org/app": { wrap: "true", font: "'Mono'" } } },
      ),
    ).toMatchObject({
      kind: "keys",
      added: ["org/app/font"],
      changed: ["org/app/wrap"],
    });
  });

  it("matches SQLite rows by primary key, and by whole row without one", () => {
    const before = {
      tables: {
        notes: {
          columns: ["id", "body"],
          primary_key: ["id"],
          rows: [
            [1, "a"],
            [2, "b"],
          ],
        },
        log: { columns: ["line"], primary_key: [], rows: [["x"], ["x"]] },
      },
    };
    const after = {
      tables: {
        notes: {
          columns: ["id", "body"],
          primary_key: ["id"],
          rows: [
            [1, "A"],
            [3, "c"],
          ],
        },
        log: { columns: ["line"], primary_key: [], rows: [["x"]] },
      },
    };
    expect(diffStateViews("sqlite", before, after)).toMatchObject({
      kind: "rows",
      added: ["notes:[3]"],
      removed: ["notes:[2]", 'log:["x"]#1'],
      changed: ["notes:[1]"],
    });
  });
});

describe("diffStateViews fidelity", () => {
  it("keeps empty containers as values", () => {
    expect(diffStateViews("json", {}, { items: [] })).toMatchObject({
      added: ["/items"],
      removed: [],
    });
    expect(diffStateViews("json", { items: [] }, { items: {} })).toMatchObject({
      changed: ["/items"],
    });
  });

  it("reports an array that becomes an object with the same members", () => {
    expect(
      diffStateViews("json", { items: [1] }, { items: { "0": 1 } }),
    ).toMatchObject({ added: [], removed: [], changed: ["/items"] });
    expect(diffStateViews("json", [[1]], { "0": [1] })).toMatchObject({
      changed: [""],
      changed_count: 1,
    });
  });

  it("lists added subtrees in document order and counts a pointer too long to list", () => {
    expect(
      diffStateViews("json", { a: 1 }, { a: 1, b: { c: [true] }, d: null }),
    ).toMatchObject({
      added: ["/b", "/b/c", "/b/c/0", "/d"],
      added_count: 4,
    });
    const key = "k".repeat(1000);
    const deep = (leaf: number) => {
      let value: JsonValue = leaf;
      for (let level = 0; level < 8; level += 1) value = { [key]: value };
      return value;
    };
    expect(diffStateViews("json", deep(1), deep(2))).toMatchObject({
      changed: [],
      changed_count: 1,
    });
  });

  it("keeps a key holding / apart from a group holding it", () => {
    const nested = { "a/b": { c: "1" } };
    const flat = { a: { "b/c": "1" } };
    expect(
      diffStateViews("keyfile", { groups: nested }, { groups: flat }),
    ).toMatchObject({ added: ["a/b~1c"], removed: ["a/b/c"], changed: [] });
    // Both spellings in one file stay two entries rather than one replacing the other.
    expect(
      diffStateViews(
        "keyfile",
        { groups: { ...nested, ...flat } },
        { groups: { "a/b": { c: "2" }, ...flat } },
      ),
    ).toMatchObject({ changed: ["a/b/c"], changed_count: 1 });
  });

  it("marks comparisons of truncated views as incomplete", () => {
    expect(
      diffStateViews(
        "text",
        { lines: ["a"], truncated: true },
        { lines: ["b"], truncated: false },
      ).complete,
    ).toBe(false);
    expect(
      diffStateViews(
        "sqlite",
        {
          tables: {
            t: { columns: [], primary_key: [], rows: [], truncated: true },
          },
        },
        {
          tables: {
            t: { columns: [], primary_key: [], rows: [], truncated: false },
          },
        },
      ).complete,
    ).toBe(false);
  });

  it("leaves a table that could not be read out of the comparison and marks it incomplete", () => {
    const table = (rows: number[][]) => ({
      columns: ["id"],
      primary_key: ["id"],
      rows,
      truncated: false,
    });
    expect(
      diffStateViews(
        "sqlite",
        { tables: { notes: table([[1]]), log: table([[1], [2]]) } },
        { tables: { notes: table([[1], [2]]), log: { error: "malformed" } } },
      ),
    ).toMatchObject({
      added: ["notes:[2]"],
      removed: [],
      complete: false,
    });
  });

  it("treats truncated fields in JSON as data, not coverage", () => {
    expect(
      diffStateViews(
        "json",
        { truncated: true, count: 1 },
        { truncated: true, count: 2 },
      ).complete,
    ).toBe(true);
  });
});

/** An archive holding one JSON entry, `a.json`, whose view is `{items}`. */
const jsonArchive = (items: JsonValue): JsonValue => ({
  entries: [
    {
      name: "a.json",
      size: 1,
      sha256: "a",
      format: "json",
      view: { items },
      view_error: null,
    },
  ],
  entry_count: 1,
  truncated: false,
});

describe("diffStateViews zip member pairing", () => {
  it("compares counterparts by the evaluator's pointer rules, a bracketed key against an array as a selector", () => {
    const keyed = { "[name=x]": 1 };
    const listed = [{ name: "x" }];
    const items = "/entries/[name=a.json]/view/items";

    expect(
      diffStateViews("zip", jsonArchive(keyed), jsonArchive(listed)),
    ).toMatchObject({
      added: [`${items}/[name=x]/name`],
      removed: [],
      changed: [items, `${items}/[name=x]`],
    });
    expect(
      diffStateViews("zip", jsonArchive(listed), jsonArchive(keyed)),
    ).toMatchObject({
      added: [],
      removed: [`${items}/[name=x]/name`],
      changed: [items, `${items}/[name=x]`],
    });
    expect(
      diffStateViews("json", { items: keyed }, { items: listed }),
    ).toMatchObject({
      added: ["/items/0", "/items/0/name"],
      removed: [],
      changed: ["/items"],
    });
  });

  it("compares an array's members with what their pointers name once it becomes an object", () => {
    const unchanged = {
      added: [],
      removed: [],
      changed: ["/entries/[name=a.json]/view/items"],
      complete: true,
    };

    expect(
      diffStateViews("zip", jsonArchive([1]), jsonArchive({ "0": 1 })),
    ).toMatchObject(unchanged);
    expect(
      diffStateViews("zip", jsonArchive({ "0": 1 }), jsonArchive([1])),
    ).toMatchObject(unchanged);
  });

  it("pairs each element with at most one in the other version, so one split in two is an addition", () => {
    const item = (attributes: Record<string, string>) => ({
      name: "item",
      attributes,
      children: [],
    });
    const archive = (items: JsonValue[]): JsonValue => ({
      entries: [
        {
          name: "list.xml",
          size: 1,
          sha256: String(items.length),
          format: "xml",
          view: {
            root: { name: "list", attributes: {}, children: items },
            truncated: false,
          },
          view_error: null,
        },
      ],
      entry_count: 1,
      truncated: false,
    });

    const difference = diffStateViews(
      "zip",
      archive([item({ a: "x", b: "y" })]),
      archive([item({ b: "y" }), item({ a: "x" })]),
    );

    const items = "/entries/[name=list.xml]/view/root/children";
    expect(difference).toMatchObject({
      added: [
        `${items}/1`,
        `${items}/1/name`,
        `${items}/1/attributes`,
        `${items}/1/attributes/a`,
        `${items}/1/children`,
      ],
      removed: [`${items}/[name=item][@b=y]/attributes/a`],
      changed: ["/entries/[name=list.xml]/sha256"],
      complete: true,
    });
  });
});

describe("diffStateViews zip archives", () => {
  it("matches zip entries and XML elements by name, so an inserted one shifts nothing", () => {
    const element = (name: string, attributes: Record<string, string>) => ({
      name,
      attributes,
      children: [],
    });
    const archive = (objects: JsonValue[], radius: string): JsonValue => ({
      entries: [
        {
          name: "thumb.png",
          size: 3,
          sha256: "a",
          format: "binary",
          view: null,
        },
        {
          name: "Document.xml",
          size: 9,
          sha256: radius,
          format: "xml",
          view: {
            root: { name: "Document", attributes: {}, children: objects },
            truncated: false,
          },
          view_error: null,
        },
      ],
      entry_count: 2,
      truncated: false,
    });
    const plate = element("Object", { name: "Plate", type: "Part::Box" });
    const hole = element("Object", { name: "Hole", type: "Part::Cylinder" });

    const difference = diffStateViews(
      "zip",
      archive([plate], "1"),
      archive(
        [hole, { ...plate, attributes: { name: "Plate", type: "Part::Cut" } }],
        "2",
      ),
    );

    const objects = "/entries/[name=Document.xml]/view/root/children";
    expect(difference).toMatchObject({
      kind: "values",
      added: [
        `${objects}/[name=Object][@name=Hole]`,
        `${objects}/[name=Object][@name=Hole]/name`,
        `${objects}/[name=Object][@name=Hole]/attributes`,
        `${objects}/[name=Object][@name=Hole]/attributes/name`,
        `${objects}/[name=Object][@name=Hole]/attributes/type`,
        `${objects}/[name=Object][@name=Hole]/children`,
      ],
      removed: [],
      changed: [
        "/entries/[name=Document.xml]/sha256",
        `${objects}/[name=Object][@name=Plate]/attributes/type`,
      ],
      complete: true,
    });
  });

  it("marks a zip comparison incomplete when an entry was left unread or its view cut", () => {
    const listing = (entry: JsonValue): JsonValue => ({
      entries: [entry],
      entry_count: 1,
      truncated: false,
    });
    const read = {
      name: "a.txt",
      size: 1,
      format: "text",
      view: { lines: [] },
      view_error: null,
    };

    expect(
      diffStateViews(
        "zip",
        listing(read),
        listing({ ...read, view_error: "encrypted, so it is not read" }),
      ).complete,
    ).toBe(false);
    expect(
      diffStateViews(
        "zip",
        listing(read),
        listing({ ...read, view: { lines: [], truncated: true } }),
      ).complete,
    ).toBe(false);
    expect(
      diffStateViews("zip", listing(read), {
        entries: [],
        entry_count: 1001,
        truncated: true,
      }).complete,
    ).toBe(false);
    expect(diffStateViews("zip", listing(read), listing(read)).complete).toBe(
      true,
    );
  });
});
