import { unknownTarget } from "../../domain/targetIdentity.js";
import { describe, expect, it } from "vitest";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { createEvidence } from "../../domain/evidence.js";
import { err, ok } from "../../domain/result.js";
import type { SqliteDatabase } from "../../domain/sqlite/sqliteDatabase.js";
import { diffStateViews } from "../../domain/desktop/stateChanges.js";
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

type Rows = NonNullable<SqliteDatabase["rows"]>["values"];

const report = (
  selected: string | undefined,
  values: Rows,
  tables: string[],
): SqliteDatabase => ({
  artifact: { path: "/staged/state.db", sha256: "a".repeat(64), bytes: 4096 },
  wal: null,
  engine: { name: "SQLite", version: "3.50.2" },
  worker_timeout_ms: 30_000,
  database_encoding: "UTF-8",
  schema: {
    scope: "database",
    completeness: "complete",
    tables: tables.map(table),
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
          values,
          row_limit: 500,
          returned_rows: values.length,
          truncated: false,
          order: "unspecified",
          row_offset: 0,
          next_row_offset: null,
        },
  limitations: [],
});

const service = (values: Rows, failure?: AnalysisError) => ({
  inspect: async (input: unknown) => {
    const selected = (input as { readonly table?: string }).table;
    if (selected === "broken" && failure !== undefined) return err(failure);
    return ok(
      createEvidence(
        unknownTarget("not-observed"),
        { id: "sqlite", name: "SQLite", version: "1" },
        {
          operation: OPERATION,
          parameters: {},
          result: report(
            selected,
            values,
            failure === undefined ? ["notes"] : ["notes", "broken"],
          ),
          confidence: "observed",
        },
      ),
    );
  },
});

describe("readSqliteStateView", () => {
  it("distinguishes special REAL values from text when comparing captured rows", async () => {
    const values = ["Infinity", "-Infinity", "-0"] as const;
    const real = await readSqliteStateView(
      service(values.map((value) => [{ type: "real", value }])),
      "/staged/state.db",
    );
    const text = await readSqliteStateView(
      service(
        values.map((value) => [
          {
            type: "text",
            value,
            bytes_hex: Buffer.from(value).toString("hex"),
            encoding: "UTF-8",
          },
        ]),
      ),
      "/staged/state.db",
    );
    expect(real).toMatchObject({
      ok: true,
      view: {
        tables: {
          notes: {
            rows: [
              [{ real: "Infinity" }],
              [{ real: "-Infinity" }],
              [{ real: "-0" }],
            ],
          },
        },
      },
    });
    expect(text).toMatchObject({
      ok: true,
      view: {
        tables: {
          notes: {
            rows: [["Infinity"], ["-Infinity"], ["-0"]],
          },
        },
      },
    });
    if (!real.ok || !text.ok) throw new Error("Expected readable SQLite views");
    expect(diffStateViews("sqlite", real.view, text.view)).toMatchObject({
      added_count: 3,
      removed_count: 3,
      complete: true,
    });
  });

  it("propagates cancellation from a table read", async () => {
    const cancelled = new AnalysisCancelledError(OPERATION, {
      cause: "stopped",
    });

    await expect(
      readSqliteStateView(
        service([[{ type: "integer", value: "1" }]], cancelled),
        "/staged/state.db",
      ),
    ).rejects.toBe(cancelled);
  });
});
