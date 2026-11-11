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
      "Inspect a local SQLite snapshot and sibling WAL without modifying them. Returns their SHA-256 and schema inventory; select an exact ordinary table and columns for rows (default 20), or schema_scope database for expanded schema. row_offset pages a stated rowid/primary-key order only while database/WAL digests match; fully shadowed rowid aliases have unspecified order and cannot page. Values preserve 64-bit integers, text bytes and blobs with explicit truncation. Requires Node.js 24.x >=24.15 or 26+ with DatabaseSync.limits. worker_timeout_ms bounds worker startup/query/reply work, not snapshot acquisition, cleanup or host delivery; independent safety budgets remain. Supply a quiescent snapshot; no atomic live-snapshot claim. No arbitrary SQL, WHERE/ORDER BY, views/virtual tables, extensions, repair or encryption. Two inspections may run per provider; occupied capacity is retryable. Temporary-copy/worker bounds do not cap overall native heap.",
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
