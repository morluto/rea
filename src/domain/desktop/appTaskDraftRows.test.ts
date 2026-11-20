import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";
import { draftOf, statePath } from "./appTaskDraft.fixture.js";

const FILE = "Documents/notes.db";
const table = (body: string, truncated = false) => ({
  columns: ["id", "body"],
  primary_key: ["id"],
  rows: [[1, body]],
  truncated,
});
const database = (tables: JsonValue, tables_truncated = false) => ({
  tables,
  tables_truncated,
});
const draft = (before: JsonValue, after: JsonValue) =>
  draftOf({ [FILE]: statePath("document", "sqlite", before, after) })[0];

describe("SQLite draft row boundaries", () => {
  it.each([
    database({ notes: table("kept", true) }),
    database({ notes: { error: "permission denied" } }),
    database({}, true),
  ])(
    "keeps unknown baseline rows separate from known empty tables: %j",
    (before) => {
      const after = database({ notes: table("kept"), other: table("new") });
      const file = draft(before, after);
      expect(file).toBeDefined();
      expect(
        file?.suggested.some(
          (check) => "table" in check && check.table === "notes",
        ),
      ).toBe(false);
      // The complete inventory can still establish that another table is new.
      expect(
        file?.suggested.some(
          (check) => "table" in check && check.table === "other",
        ),
      ).toBe(before.tables_truncated === false);
    },
  );

  it("retains checks for changes in fully read sibling tables", () => {
    const before = database({
      notes: table("kept", true),
      other: table("old"),
    });
    const after = database({ notes: table("kept"), other: table("new") });
    const checks = draft(before, after)?.suggested ?? [];
    expect(checks).toEqual([
      {
        kind: "row_present",
        file: FILE,
        table: "other",
        where: { id: 1, body: "new" },
      },
    ]);
    for (const [view, passed] of [
      [before, false],
      [after, true],
    ] as const)
      expect(
        evaluateTaskChecks(
          checks.map((check) => ({ ...check, id: "changed" })),
          new Map([[FILE, { format: "sqlite", view }]]),
        ).map((result) => result.passed),
      ).toEqual([passed]);
  });

  it("suggests only predicates that distinguish keyed rows after timestamp omission", () => {
    const saved = (stamp: string) =>
      database({
        notes: {
          columns: ["id", "body", "saved"],
          primary_key: ["id"],
          rows: [[1, "kept", stamp]],
          truncated: false,
        },
      });
    expect(
      draft(saved("2026-11-04 09:00:00"), saved("2026-11-04 10:00:00"))
        ?.suggested ?? [],
    ).toEqual([]);
  });

  it("compares projected predicates against siblings when timestamp keys are omitted", () => {
    const rows = (first: string) =>
      database({
        notes: {
          columns: ["stamp", "body"],
          primary_key: ["stamp"],
          rows: [
            ["2026-11-04 09:00:00", first],
            ["2026-11-04 10:00:00", "new"],
          ],
          truncated: false,
        },
      });
    const before = rows("old");
    const after = rows("new");
    expect(draft(before, after)?.suggested ?? []).toEqual([]);
  });

  it("keeps a newly created SQLite file's presence check", () => {
    const after = database({ notes: table("new") });
    const file = draftOf({
      [FILE]: statePath("document", "sqlite", null, after),
    })[0];
    expect(file?.suggested).toEqual([{ kind: "file_present", file: FILE }]);
  });

  it("compares keyed rows by column names through a table rebuild", () => {
    const before = database({ notes: table("kept") });
    const reordered = (body: string) =>
      database({
        notes: {
          columns: ["body", "id"],
          primary_key: ["id"],
          rows: [[body, 1]],
          truncated: false,
        },
      });
    expect(draft(before, reordered("kept"))?.suggested ?? []).toEqual([]);
    const after = reordered("edited");
    const checks = draft(before, after)?.suggested ?? [];
    expect(checks).toEqual([
      {
        kind: "row_present",
        file: FILE,
        table: "notes",
        where: { body: "edited", id: 1 },
      },
    ]);
    for (const [view, passed] of [
      [before, false],
      [after, true],
    ] as const)
      expect(
        evaluateTaskChecks(
          checks.map((check) => ({ ...check, id: "changed" })),
          new Map([[FILE, { format: "sqlite", view }]]),
        ).map((result) => result.passed),
      ).toEqual([passed]);
  });
});
