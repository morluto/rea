import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { diffStateViews } from "./stateChanges.js";
import { keyfileView } from "./stateFormats.js";
import { resolvePointer } from "./viewPointer.js";

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

  it("compares NULL primary-key rows as a multiset while retaining keyed matches", () => {
    const table = (rows: (string | null)[][]) => ({
      tables: {
        items: { columns: ["id", "body"], primary_key: ["id"], rows },
      },
    });
    const before = table([
      [null, "alpha"],
      [null, "beta"],
      ["fixed", "old"],
    ]);
    expect(
      diffStateViews(
        "sqlite",
        before,
        table([
          ["fixed", "old"],
          [null, "beta"],
          [null, "alpha"],
        ]),
      ),
    ).toMatchObject({
      added_count: 0,
      removed_count: 0,
      changed_count: 0,
    });
    expect(
      diffStateViews(
        "sqlite",
        before,
        table([
          [null, "gamma"],
          [null, "beta"],
          ["fixed", "new"],
        ]),
      ),
    ).toMatchObject({
      added: ['items:[null,"gamma"]'],
      removed: ['items:[null,"alpha"]'],
      changed: ['items:["fixed"]'],
    });
  });
});

describe("diffStateViews fidelity", () => {
  it("preserves significant keyfile whitespace in views and differences", () => {
    const view = (suffix: string, unicode: string, padding: string) =>
      keyfileView(
        `[ui]\r\nsuffix=${suffix}\r\nunicode=${unicode}\r\npadded=${padding}\r\n`,
      );
    const before = view("hello ", "\u00a0hello\u00a0", "   hello");
    const after = view("hello  ", "\u00a0hello\u00a0\u00a0", "\thello");
    expect(before.ui).toEqual({
      suffix: "hello ",
      unicode: "\u00a0hello\u00a0",
      padded: "hello",
    });
    expect(after.ui).toEqual({
      suffix: "hello  ",
      unicode: "\u00a0hello\u00a0\u00a0",
      padded: "hello",
    });
    expect(
      diffStateViews("keyfile", { groups: before }, { groups: after }),
    ).toMatchObject({
      kind: "keys",
      changed: ["ui/suffix", "ui/unicode"],
      changed_count: 2,
      complete: true,
    });
  });

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

/**
 * Diff an object of selector keys, each naming one of `size` members named
 * n0, n1 and on, against them, and expect a few reads of each member, not a
 * pass over the array per key.
 */
const expectFewReads = (keyed: Record<string, JsonValue>, size: number) => {
  let reads = 0;
  const listed = new Proxy(
    Array.from({ length: size }, (_, index) => ({
      name: `n${String(index)}`,
    })),
    {
      get: (target, key, receiver) => {
        if (typeof key === "string" && /^[0-9]+$/u.test(key)) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    },
  );

  const difference = diffStateViews(
    "json",
    { items: keyed },
    { items: listed as JsonValue },
  );

  expect(difference).toMatchObject({ removed: [], removed_count: 0 });
  expect(reads).toBeLessThan(10 * size);
};

describe("diffStateViews selector lookups", () => {
  it("reads every spelling of a selector as the evaluator does", () => {
    const listed = [
      { name: "n0", kind: "a" },
      { name: "n1", kind: "a" },
    ];
    const keyed = {
      "[kind=a][name=n0]": 1,
      "[name=n1][kind=a][name=n1]": 2,
      "[name=n0][name=n1]": 3,
      "[kind=a]": 4,
    };

    const difference = diffStateViews(
      "json",
      { items: keyed },
      { items: listed },
    );

    expect(difference.removed).toEqual([
      "/items/[name=n0][name=n1]",
      "/items/[kind=a]",
    ]);
    for (const key of Object.keys(keyed))
      expect(
        resolvePointer({ items: listed }, `/items/${key}`) === undefined,
      ).toBe(difference.removed.includes(`/items/${key}`));
  });

  it("resolves selectors that repeat a condition as one, in one pass over the array", () => {
    // An index per spelling of the same selector read the 800 members once for each of the 160.
    expectFewReads(
      Object.fromEntries(
        Array.from({ length: 160 }, (_, index) => [
          "[name=n0]".repeat(index + 1),
          index,
        ]),
      ),
      800,
    );
  });

  it("compares a wide object of selector keys with an array in one pass over the array, not one per key", () => {
    const size = 2000;

    // A scan of the array per key read its members about size * size times.
    expectFewReads(
      Object.fromEntries(
        Array.from({ length: size }, (_, index) => [
          `[name=n${String(index)}]`,
          index,
        ]),
      ),
      size,
    );
  });
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

describe("diffStateViews zip member pairing by identity", () => {
  it("pairs an element by an attribute both versions keep, so another attribute's new value is a change", () => {
    const item = (attributes: Record<string, string>) => ({
      name: "item",
      attributes,
      children: [],
    });
    const archive = (color: string): JsonValue => ({
      entries: [
        {
          name: "list.xml",
          size: 1,
          sha256: color,
          format: "xml",
          view: {
            root: {
              name: "list",
              attributes: {},
              children: [item({ color, id: "1" }), item({ id: "2" })],
            },
            truncated: false,
          },
          view_error: null,
        },
      ],
      entry_count: 1,
      truncated: false,
    });

    expect(
      diffStateViews("zip", archive("red"), archive("green")),
    ).toMatchObject({
      added: [],
      removed: [],
      changed: [
        "/entries/[name=list.xml]/sha256",
        "/entries/[name=list.xml]/view/root/children/[name=item][@id=1]/attributes/color",
      ],
      complete: true,
    });
  });

  it("counts every attribute of an identified element, so a selector it shares names nothing removed", () => {
    const archive = (first: string, second: string): JsonValue => ({
      entries: [
        {
          name: "list.xml",
          size: 1,
          sha256: first,
          format: "xml",
          view: {
            root: {
              name: "list",
              attributes: {},
              children: [
                { name: "item", attributes: { id: "1", color: first } },
                { name: "item", attributes: { color: second } },
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

    expect(
      diffStateViews("zip", archive("red", "blue"), archive("blue", "red")),
    ).toMatchObject({
      added: [],
      removed: [],
      changed: [
        "/entries/[name=list.xml]/sha256",
        "/entries/[name=list.xml]/view/root/children/[name=item][@id=1]/attributes/color",
        "/entries/[name=list.xml]/view/root/children/1/attributes/color",
      ],
      complete: true,
    });
  });

  it("keys an Inkscape group by its label when an identified group shares its fill", () => {
    const archive = (transform: string): JsonValue => ({
      entries: [
        {
          name: "poster.svg",
          size: 1,
          sha256: transform,
          format: "xml",
          view: {
            root: {
              name: "svg",
              attributes: {},
              children: [
                {
                  name: "g",
                  attributes: {
                    fill: "red",
                    "inkscape:label": "note",
                    transform,
                  },
                },
                { name: "g", attributes: { fill: "red", id: "layer" } },
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

    expect(
      diffStateViews("zip", archive("scale(1)"), archive("scale(2)")),
    ).toMatchObject({
      added: [],
      removed: [],
      changed: [
        "/entries/[name=poster.svg]/sha256",
        "/entries/[name=poster.svg]/view/root/children/[name=g][@inkscape:label=note]/attributes/transform",
      ],
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
