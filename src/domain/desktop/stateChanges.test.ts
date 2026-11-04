import { describe, expect, it } from "vitest";

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
      removed: [""],
    });
    expect(diffStateViews("json", { items: [] }, { items: {} })).toMatchObject({
      changed: ["/items"],
    });
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
