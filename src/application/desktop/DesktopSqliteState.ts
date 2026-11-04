import type { z } from "zod";

import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  sqliteDatabaseSchema,
  sqliteValueSchema,
  type SqliteDatabase,
} from "../../domain/sqlite/sqliteDatabase.js";
import { plainRecord } from "../../domain/desktop/stateFormats.js";
import type { SqliteDatabaseService } from "../sqlite/SqliteDatabaseService.js";

const ROW_LIMIT = 500;
const MAX_TABLES = 64;

/** A database's ordinary tables as JSON rows, or why it could not be read. */
export type SqliteStateView =
  | { readonly ok: true; readonly view: JsonValue }
  | { readonly ok: false; readonly error: string };

type Cell = z.infer<typeof sqliteValueSchema>;

/**
 * SQLite cells as JSON. Values that plain JSON would conflate keep a tagged
 * form: integers beyond the safe range, text whose bytes did not decode
 * cleanly, and blobs.
 */
const cellValue = (cell: Cell): JsonValue => {
  switch (cell.type) {
    case "null":
      return null;
    case "integer": {
      const value = Number(cell.value);
      return Number.isSafeInteger(value) ? value : { integer: cell.value };
    }
    case "real":
      return cell.value;
    case "text":
      return cell.value.includes("\uFFFD")
        ? { text: cell.value, bytes_hex: cell.bytes_hex }
        : cell.value;
    case "blob":
      return { blob_hex: cell.hex };
  }
};

type SqliteReader = Pick<SqliteDatabaseService, "inspect">;

/** One report, or why it failed; cancellation and unfinished cleanup propagate. */
const report = async (
  service: SqliteReader,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<SqliteDatabase | string> => {
  const inspected = await service.inspect(
    input,
    signal === undefined ? {} : { signal },
  );
  if (!inspected.ok) {
    if (
      inspected.error instanceof AnalysisCancelledError ||
      inspected.error.cleanupIncomplete
    )
      throw inspected.error;
    return inspected.error.message;
  }
  const parsed = sqliteDatabaseSchema.safeParse(
    inspected.value.normalized_result,
  );
  return parsed.success ? parsed.data : "unexpected SQLite report";
};

/**
 * Read every ordinary table of a staged database, with its write-ahead log
 * beside it when one was retained. A table that fails keeps its error in place
 * of its rows. The SQLite service selects one table per call.
 */
export const readSqliteStateView = async (
  service: SqliteReader,
  database: string,
  signal?: AbortSignal,
): Promise<SqliteStateView> => {
  const inventory = await report(
    service,
    { path: database, schema_scope: "database" },
    signal,
  );
  if (typeof inventory === "string") return { ok: false, error: inventory };
  const tables = plainRecord<JsonValue>();
  const ordinary = inventory.schema.tables.filter(
    (table) => table.kind === "table",
  );
  for (const table of ordinary.slice(0, MAX_TABLES)) {
    const selected = await report(
      service,
      { path: database, table: table.name, row_limit: ROW_LIMIT },
      signal,
    );
    if (typeof selected === "string") {
      tables[table.name] = { error: selected };
      continue;
    }
    const rows = selected.rows;
    tables[table.name] = {
      columns: rows?.columns ?? [],
      primary_key: table.columns
        .filter((column) => column.primary_key_position > 0)
        .sort(
          (left, right) =>
            left.primary_key_position - right.primary_key_position,
        )
        .map((column) => column.name),
      rows: (rows?.values ?? []).map((row) => row.map(cellValue)),
      truncated: rows?.truncated ?? false,
    };
  }
  return {
    ok: true,
    view: { tables, tables_truncated: ordinary.length > MAX_TABLES },
  };
};
