import { describe, expect, it } from "vitest";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence } from "../../domain/evidence.js";
import { err, ok } from "../../domain/result.js";
import { readSqliteStateView } from "./DesktopSqliteState.js";

const OPERATION = "inspect_sqlite_database";

const table = (name: string) => ({
  name,
  sql: null,
  root_page: 2,
  kind: "table" as const,
  without_rowid: false,
  strict: false,
  column_count: 1,
  columns_completeness: "complete" as const,
  columns: [
    {
      cid: 0,
      name: "id",
      declared_type: "INTEGER",
      not_null: false,
      default_sql: null,
      primary_key_position: 1,
      hidden: 0 as const,
    },
  ],
});

/** A SQLite report with two tables, and one row of the selected table. */
const report = (selected: string | undefined) => ({
  artifact: { path: "/staged/state.db", sha256: "a".repeat(64), bytes: 4096 },
  wal: null,
  engine: { name: "SQLite", version: "3.50.2" },
  database_encoding: "UTF-8",
  schema: {
    scope: "database",
    completeness: "complete",
    tables: [table("notes"), table("broken")],
    indexes: [],
    views: [],
    triggers: [],
  },
  rows:
    selected === undefined
      ? null
      : {
          table: selected,
          columns: ["id"],
          values: [[{ type: "integer", value: "1" }]],
          row_limit: 500,
          returned_rows: 1,
          truncated: false,
          order: "unspecified",
        },
  limitations: [],
});

/** A SQLite service whose table reads fail where `failure` says so. */
const service = (failure: (table: string) => AnalysisError | undefined) => ({
  inspect: async (input: unknown) => {
    const selected = (input as { readonly table?: string }).table;
    const refused = selected === undefined ? undefined : failure(selected);
    if (refused !== undefined) return err(refused);
    return ok(
      createEvidence(
        undefined,
        { id: "sqlite", name: "SQLite", version: "1" },
        {
          operation: OPERATION,
          parameters: {},
          result: report(selected),
          confidence: "observed",
        },
      ),
    );
  },
});

describe("readSqliteStateView", () => {
  it("keeps the tables that read and records the error of one that did not", async () => {
    const read = await readSqliteStateView(
      service((name) =>
        name === "broken"
          ? new AnalysisOutputError(OPERATION, "table unreadable")
          : undefined,
      ),
      "/staged/state.db",
    );

    expect(read).toMatchObject({
      ok: true,
      view: {
        tables: {
          notes: { primary_key: ["id"], rows: [[1]], truncated: false },
          broken: { error: expect.stringContaining("table unreadable") },
        },
        tables_truncated: false,
      },
    });
  });

  it("propagates cancellation from a table read", async () => {
    const cancelled = new AnalysisCancelledError(OPERATION, {
      cause: "stopped",
    });

    await expect(
      readSqliteStateView(
        service((name) => (name === "broken" ? cancelled : undefined)),
        "/staged/state.db",
      ),
    ).rejects.toBe(cancelled);
  });
});
