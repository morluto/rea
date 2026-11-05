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
