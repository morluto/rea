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
    description:
      "Inspect an explicit local SQLite database snapshot and its existing sibling WAL without modifying source files or opening a native analysis provider. Requires Node.js 24.x >=24.15 or 26+ with native DatabaseSync.limits support, checked by the worker. Returns database/WAL SHA-256, tables and columns, indexes, views and triggers inline as observed Evidence. Optionally select an exact ordinary table and a row limit (default 100, subject to byte and worker resource limits); returned rows retain 64-bit integers, text bytes and blobs with explicit truncation. No arbitrary SQL, view or virtual-table execution, extension loading, database repair, encryption support or live-snapshot atomicity claim. An isolated temporary copy and owned worker enforce input, value/record, SQL-statement, JSON-reply, JavaScript-heap and deadline limits; overall native heap is not capped. Supply a quiescent snapshot for coherent database/WAL evidence.",
    inputSchema: inspectSqliteDatabaseInputSchema,
    outputSchema: evidenceResultOf(sqliteDatabaseSchema),
    examples: [
      {
        title: "Inspect the complete schema of a local SQLite snapshot",
        input: { path: "/artifacts/application.sqlite" },
      },
      {
        title: "Read selected rows from an ordinary table",
        input: {
          path: "/artifacts/application.sqlite",
          table: "settings",
          row_limit: 20,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
