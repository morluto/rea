import { describe, expect, it } from "vitest";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
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

/** A SQLite report with two tables, and one row of the selected table. */
const report = (selected: string | undefined): SqliteDatabase => ({
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
          row_offset: 0,
          next_row_offset: null,
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
  it("distinguishes special REAL values from text when comparing captured rows", async () => {
    const read = async (type: "real" | "text") =>
      readSqliteStateView(
        {
          inspect: async (input: unknown) => {
            const selected = (input as { table?: string }).table;
            const result: SqliteDatabase = report(selected);
            result.schema.tables = [table("notes")];
            if (result.rows !== null) {
              result.rows.values = (
                ["Infinity", "-Infinity", "-0"] as const
              ).map((value) => [
                type === "real"
                  ? { type: "real", value }
                  : {
                      type: "text",
                      value,
                      bytes_hex: Buffer.from(value).toString("hex"),
                      encoding: "UTF-8",
                    },
              ]);
              result.rows.returned_rows = 3;
            }
            return ok(
              createEvidence(
                undefined,
                { id: "sqlite", name: "SQLite", version: "1" },
                {
                  operation: OPERATION,
                  parameters: {},
                  result,
                  confidence: "observed",
                },
              ),
            );
          },
        },
        "/staged/state.db",
      );
    const real = await read("real");
    const text = await read("text");
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
