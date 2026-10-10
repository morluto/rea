import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";

/** Default ordinary-table sample size when the caller selects a table. */
export const SQLITE_ROW_LIMIT_DEFAULT = 100;

const nonnegative = z.number().int().nonnegative();
const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const encoding = z.enum(["UTF-8", "UTF-16le", "UTF-16be"]);
const artifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: nonnegative,
});

/** Inspect one frozen database and its sibling WAL, with optional ordinary-table rows. */
export const inspectSqliteDatabaseInputSchema = z
  .strictObject({
    path: localPathStringSchema.describe(
      "Absolute path to an offline SQLite database snapshot",
    ),
    table: z
      .string()
      .optional()
      .describe(
        "Exact ordinary table name; views and virtual/shadow tables are not executed",
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Selected-table sample size, default 100; subject to byte and worker resource limits",
      ),
  })
  .superRefine((input, context) => {
    if (input.row_limit !== undefined && input.table === undefined)
      context.addIssue({
        code: "custom",
        path: ["row_limit"],
        message: "row_limit requires an explicit table selection",
      });
  })
  .meta({ dependentRequired: { row_limit: ["table"] } });

/** JSON-safe SQLite cells retain integers, binary content and special REAL values. */
export const sqliteValueSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("null") }),
  z.strictObject({
    type: z.literal("integer"),
    value: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/),
  }),
  z.strictObject({
    type: z.literal("real"),
    value: z.union([z.number(), z.enum(["Infinity", "-Infinity", "-0"])]),
  }),
  z.strictObject({
    type: z.literal("text"),
    value: z.string(),
    bytes_hex: hex,
    encoding,
  }),
  z.strictObject({ type: z.literal("blob"), hex }),
]);

/** Frozen schema facts and explicitly bounded selected records, without arbitrary SQL. */
export const sqliteDatabaseSchema = z
  .strictObject({
    artifact: artifactSchema,
    wal: artifactSchema.nullable(),
    engine: z.strictObject({
      name: z.literal("SQLite"),
      version: z.string().min(1),
    }),
    database_encoding: encoding,
    schema: z.strictObject({
      completeness: z.literal("complete"),
      tables: z.array(
        z.strictObject({
          name: z.string(),
          sql: z.string().nullable(),
          root_page: nonnegative,
          kind: z
            .enum(["table", "virtual", "shadow", "unknown"])
            .describe(
              "Unknown means a possible shadow table of an unresolved virtual table; its rows cannot be inspected",
            ),
          without_rowid: z.boolean(),
          strict: z.boolean(),
          columns_completeness: z.enum(["complete", "unsupported"]),
          columns: z.array(
            z.strictObject({
              cid: nonnegative,
              name: z.string(),
              declared_type: z.string(),
              not_null: z.boolean(),
              default_sql: z.string().nullable(),
              primary_key_position: nonnegative,
              hidden: z.union([
                z.literal(0),
                z.literal(1),
                z.literal(2),
                z.literal(3),
              ]),
            }),
          ),
        }),
      ),
      indexes: z.array(
        z.strictObject({
          name: z.string(),
          table: z.string(),
          sql: z.string().nullable(),
          root_page: nonnegative,
        }),
      ),
      views: z.array(
        z.strictObject({ name: z.string(), sql: z.string().nullable() }),
      ),
      triggers: z.array(
        z.strictObject({
          name: z.string(),
          table: z.string(),
          sql: z.string().nullable(),
        }),
      ),
    }),
    rows: z
      .strictObject({
        table: z.string(),
        columns: z.array(z.string()),
        values: z.array(z.array(sqliteValueSchema)),
        row_limit: z.number().int().min(1),
        returned_rows: nonnegative,
        truncated: z.boolean(),
        order: z.literal("unspecified"),
      })
      .nullable(),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    const rows = report.rows;
    if (
      rows !== null &&
      (rows.returned_rows !== rows.values.length ||
        rows.returned_rows > rows.row_limit ||
        rows.values.some((row) => row.length !== rows.columns.length))
    )
      context.addIssue({
        code: "custom",
        path: ["rows"],
        message:
          "Selected row counts and column dimensions must match the retained values",
      });
  });

export type InspectSqliteDatabaseInput = z.infer<
  typeof inspectSqliteDatabaseInputSchema
>;
export type SqliteDatabase = z.infer<typeof sqliteDatabaseSchema>;
export type SqliteValue = z.infer<typeof sqliteValueSchema>;
