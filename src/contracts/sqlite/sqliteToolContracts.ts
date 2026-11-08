import {
  inspectSqliteDatabaseInputSchema,
  sqliteDatabaseSchema,
} from "../../domain/sqlite/sqliteDatabase.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Snapshot inspection is independent of any active native-analysis target. */
export const SQLITE_TOOL_CONTRACTS = [
  {
    name: "inspect_sqlite_database",
    ...toolContractMetadata("inspect_sqlite_database"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect an explicit local SQLite database snapshot and its existing sibling WAL without modifying source files or opening a native analysis provider. Requires Node.js 24.x >=24.15 or 26+ with native DatabaseSync.limits support, checked by the worker. Returns observed Evidence with database/WAL SHA-256 and a compact schema inventory. Selecting an exact ordinary table expands only its schema and samples rows (default 20, subject to byte and worker resource limits). Retained rows are read in a stated unique order (rowid, or the declared primary key for WITHOUT ROWID tables) and report row_offset/next_row_offset, so a caller can page with row_offset; pages compose only while the reported artifact and WAL SHA-256 match. A rowid table whose rowid, _rowid_ and oid are all shadowed by declared columns has no unique order to report: it returns order=unspecified with a null next_row_offset and refuses any non-zero row_offset, so a continuation needs the table read without offsets. Select exact columns in the requested order to avoid unrelated or large values; schema_scope=database explicitly expands the whole schema; returned rows retain 64-bit integers, text bytes and blobs with explicit truncation. Adjust worker_timeout_ms (default 30000 ms) for worker startup, queries and reply writing; allow separate client headroom for snapshot acquisition, reply reads, cleanup and delivery. The result retains the actual budget; byte/heap safety limits stay fixed. No arbitrary SQL, ORDER BY or WHERE, view or virtual-table execution, extension loading, database repair, encryption support or live-snapshot atomicity claim. At most two inspections per provider are admitted; occupied capacity is retryable. An isolated temporary copy and owned worker enforce input, value/record, SQL-statement, JSON-reply, JavaScript-heap and deadline limits; overall native heap is not capped. Supply a quiescent snapshot for coherent database/WAL evidence.",
    inputSchema: inspectSqliteDatabaseInputSchema,
    outputSchema: evidenceResultOf(sqliteDatabaseSchema),
    examples: [
      {
        title: "Inspect a compact inventory of a local SQLite snapshot",
        input: { path: "/artifacts/application.sqlite" },
      },
      {
        title: "Read selected rows from an ordinary table",
        input: {
          path: "/artifacts/application.sqlite",
          table: "settings",
          columns: ["key", "value"],
          row_limit: 20,
        },
      },
      {
        title: "Read a later page of selected rows in a stated order",
        input: {
          path: "/artifacts/application.sqlite",
          table: "settings",
          row_offset: 20,
          row_limit: 20,
        },
      },
      {
        title: "Expand the complete stored schema",
        input: {
          path: "/artifacts/application.sqlite",
          schema_scope: "database",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
