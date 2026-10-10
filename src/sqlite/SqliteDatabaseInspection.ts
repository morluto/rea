import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  SQLITE_ROW_LIMIT_DEFAULT,
  type InspectSqliteDatabaseInput,
  type SqliteDatabase,
  type SqliteValue,
} from "../domain/sqlite/sqliteDatabase.js";
import {
  SQLITE_DATABASE_LIMITS,
  SqliteInspectionFailure,
} from "./SqliteDatabaseLimits.js";

const natural = z
  .bigint()
  .nonnegative()
  .max(BigInt(Number.MAX_SAFE_INTEGER))
  .transform(Number);
const schemaRow = z.object({
  type: z.enum(["table", "index", "view", "trigger"]),
  name: z.instanceof(Uint8Array),
  tbl_name: z.instanceof(Uint8Array),
  rootpage: natural,
  sql: z.instanceof(Uint8Array).nullable(),
});
const tableRow = z.object({
  schema: z.string(),
  name: z.string(),
  type: z.enum(["table", "view", "virtual", "shadow"]),
  ncol: natural,
  wr: z.bigint(),
  strict: z.bigint(),
});
const columnRow = z.object({
  cid: natural,
  name: z.string(),
  type: z.string(),
  notnull: z.bigint(),
  dflt_value: z.string().nullable(),
  pk: natural,
  hidden: z
    .bigint()
    .transform(Number)
    .pipe(z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])),
});
const arrayRow = z.array(
  z.union([
    z.null(),
    z.bigint(),
    z.custom<number>(
      (value) => typeof value === "number" && !Number.isNaN(value),
    ),
    z.string(),
  ]),
);
const encodingSchema = z.enum(["UTF-8", "UTF-16le", "UTF-16be"]);
type DatabaseEncoding = z.output<typeof encodingSchema>;
type Inspection = Pick<
  SqliteDatabase,
  "engine" | "database_encoding" | "schema" | "rows" | "limitations"
>;

class OutputBudget {
  #bytes = 1024;
  retain(value: unknown): void {
    this.#bytes += Buffer.byteLength(JSON.stringify(value)) + 1;
    if (this.#bytes > SQLITE_DATABASE_LIMITS.outputBytes)
      throw new SqliteInspectionFailure(
        "output-limit",
        "Complete SQLite evidence exceeds the 16 MiB JSON reply budget; no partial success was returned.",
      );
  }
  beforeDecode(row: z.output<typeof arrayRow>): void {
    let minimumBytes = this.#bytes;
    for (const value of row)
      if (typeof value === "string") minimumBytes += Buffer.byteLength(value);
    if (minimumBytes > SQLITE_DATABASE_LIMITS.outputBytes)
      throw new SqliteInspectionFailure(
        "output-limit",
        "Selected cells exceed the 16 MiB reply budget before text/hex expansion.",
      );
  }
  beforeProjection(lengths: readonly bigint[]): void {
    const encodedBytes = lengths.reduce(
      (total, length) => total + length * 2n,
      BigInt(lengths.length * 64),
    );
    if (
      encodedBytes + BigInt(this.#bytes) >
      BigInt(SQLITE_DATABASE_LIMITS.outputBytes)
    )
      throw new SqliteInspectionFailure(
        "output-limit",
        "Selected row byte lengths exceed the 16 MiB reply budget before hex projection.",
      );
  }
}
const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;
// SQLite folds only ASCII letters when matching virtual/shadow table names.
const sqliteIdentifierKey = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const textEncoding = (encoding: DatabaseEncoding): string =>
  encoding === "UTF-8"
    ? "utf-8"
    : encoding === "UTF-16le"
      ? "utf-16le"
      : "utf-16be";

const decodeSchemaText = (
  value: Uint8Array,
  encoding: DatabaseEncoding,
  label: string,
): string => {
  try {
    return new TextDecoder(textEncoding(encoding), {
      fatal: true,
      ignoreBOM: true,
    }).decode(value);
  } catch (cause: unknown) {
    throw new SqliteInspectionFailure(
      "format",
      `SQLite schema ${label} contains malformed ${encoding} text: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

const cell = (
  value: z.output<typeof arrayRow>[number],
  encoding: DatabaseEncoding,
): SqliteValue => {
  if (value === null) return { type: "null" };
  if (typeof value === "bigint")
    return { type: "integer", value: String(value) };
  if (typeof value === "number")
    return {
      type: "real",
      value:
        value === Infinity
          ? "Infinity"
          : value === -Infinity
            ? "-Infinity"
            : Object.is(value, -0)
              ? "-0"
              : value,
    };
  const hex = value.slice(1).toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(hex))
    throw new SqliteInspectionFailure(
      "format",
      "SQLite returned an invalid encoded cell.",
    );
  if (value[0] === "b") return { type: "blob", hex };
  if (value[0] !== "t")
    throw new SqliteInspectionFailure(
      "format",
      "SQLite returned an unknown encoded cell type.",
    );
  return {
    type: "text",
    value: new TextDecoder(textEncoding(encoding), { ignoreBOM: true }).decode(
      Buffer.from(hex, "hex"),
    ),
    bytes_hex: hex,
    encoding,
  };
};

const readColumns = (
  db: DatabaseSync,
  name: string,
  budget: OutputBudget,
): SqliteDatabase["schema"]["tables"][number]["columns"] => {
  const columns: SqliteDatabase["schema"]["tables"][number]["columns"] = [];
  // Direct PRAGMA syntax cannot be shadowed by a stored table or view.
  for (const raw of db
    .prepare(`PRAGMA main.table_xinfo(${quoteIdentifier(name)})`)
    .iterate()) {
    const value = columnRow.parse(raw);
    const column = {
      cid: value.cid,
      name: value.name,
      declared_type: value.type,
      not_null: value.notnull !== 0n,
      default_sql: value.dflt_value,
      primary_key_position: value.pk,
      hidden: value.hidden,
    };
    budget.retain(column);
    columns.push(column);
  }
  return columns;
};

const readSchema = (
  db: DatabaseSync,
  context: {
    readonly budget: OutputBudget;
    readonly limitations: string[];
    readonly encoding: DatabaseEncoding;
  },
): SqliteDatabase["schema"] => {
  const { budget, limitations, encoding } = context;
  const metadata = new Map<string, z.output<typeof tableRow>>();
  // Names bound the minimum eventual schema output while metadata is collected.
  // The full schema objects below account for them in the actual reply budget.
  const metadataBudget = new OutputBudget();
  for (const raw of db.prepare("PRAGMA main.table_list").iterate()) {
    const value = tableRow.parse(raw);
    if (value.schema === "main") {
      metadataBudget.retain(value.name);
      metadata.set(value.name, value);
    }
  }
  const unresolvedVirtualTables = [...metadata.values()]
    .filter((value) => value.type === "virtual" && value.ncol === 0)
    .map((value) => ({
      name: value.name,
      prefix: sqliteIdentifierKey(`${value.name}_`),
    }));
  const schema: SqliteDatabase["schema"] = {
    completeness: "complete",
    tables: [],
    indexes: [],
    views: [],
    triggers: [],
  };
  // Raw bytes preserve text without hex expansion; avoid sorter records that
  // duplicate large names or definitions beyond SQLite's native record limit.
  for (const raw of db
    .prepare(
      "SELECT type, CAST(name AS BLOB) AS name, CAST(tbl_name AS BLOB) AS tbl_name, rootpage, CAST(sql AS BLOB) AS sql FROM main.sqlite_schema",
    )
    .iterate()) {
    const parsed = schemaRow.parse(raw);
    const value = {
      ...parsed,
      name: decodeSchemaText(parsed.name, encoding, "name"),
      tbl_name: decodeSchemaText(parsed.tbl_name, encoding, "table"),
      sql:
        parsed.sql === null
          ? null
          : decodeSchemaText(parsed.sql, encoding, "sql"),
    };
    if (value.type === "table") {
      const listed = metadata.get(value.name);
      if (listed === undefined || listed.type === "view")
        throw new SqliteInspectionFailure(
          "format",
          `SQLite schema/table inventory mismatch: ${value.name}`,
        );
      const identifier = sqliteIdentifierKey(value.name);
      const possibleShadowParent =
        listed.type === "table"
          ? unresolvedVirtualTables.find((parent) =>
              identifier.startsWith(parent.prefix),
            )
          : undefined;
      const table: SqliteDatabase["schema"]["tables"][number] = {
        name: value.name,
        sql: value.sql,
        root_page: value.rootpage,
        kind: possibleShadowParent === undefined ? listed.type : "unknown",
        without_rowid: listed.wr !== 0n,
        strict: listed.strict !== 0n,
        columns_completeness: "complete",
        columns: [],
      };
      if (possibleShadowParent !== undefined)
        limitations.push(
          `SQLite could not resolve virtual table ${possibleShadowParent.name}. Table ${value.name} may be its shadow table; its kind is unknown and row inspection is unavailable.`,
        );
      budget.retain(table);
      if (listed.type === "virtual") {
        table.columns_completeness = "unsupported";
        limitations.push(
          `Virtual table column expansion is not performed: ${value.name}. Its complete stored CREATE statement is retained.`,
        );
      } else table.columns = readColumns(db, value.name, budget);
      schema.tables.push(table);
    } else if (value.type === "index") {
      const index = {
        name: value.name,
        table: value.tbl_name,
        sql: value.sql,
        root_page: value.rootpage,
      };
      budget.retain(index);
      schema.indexes.push(index);
    } else if (value.type === "view") {
      const view = { name: value.name, sql: value.sql };
      budget.retain(view);
      schema.views.push(view);
    } else {
      const trigger = {
        name: value.name,
        table: value.tbl_name,
        sql: value.sql,
      };
      budget.retain(trigger);
      schema.triggers.push(trigger);
    }
  }
  return schema;
};

const readRows = (
  db: DatabaseSync,
  input: InspectSqliteDatabaseInput,
  schema: SqliteDatabase["schema"],
  context: {
    readonly encoding: DatabaseEncoding;
    readonly budget: OutputBudget;
  },
): SqliteDatabase["rows"] => {
  const { encoding, budget } = context;
  if (input.table === undefined) return null;
  const table = schema.tables.find((value) => value.name === input.table);
  if (table === undefined)
    throw new SqliteInspectionFailure(
      "selection",
      `Selected ordinary table does not exist with that exact name: ${input.table}`,
    );
  if (table.kind === "unknown")
    throw new SqliteInspectionFailure(
      "selection",
      `SQLite cannot determine whether selected table ${input.table} is a shadow table of an unresolved virtual table. Row inspection requires a confirmed ordinary table.`,
    );
  if (table.kind !== "table")
    throw new SqliteInspectionFailure(
      "selection",
      `Rows from ${table.kind} table ${input.table} are outside the ordinary-table inspection profile.`,
    );
  const limit = input.row_limit ?? SQLITE_ROW_LIMIT_DEFAULT;
  const columns = table.columns
    .filter((column) => column.hidden !== 1)
    .map((column) => column.name);
  const projection = columns
    .map((name) => {
      const column = quoteIdentifier(name);
      return `CASE typeof(${column}) WHEN 'text' THEN 't' || hex(CAST(${column} AS BLOB)) WHEN 'blob' THEN 'b' || hex(${column}) ELSE ${column} END`;
    })
    .join(", ");
  const source = `main.${quoteIdentifier(input.table)} NOT INDEXED`;
  const lengths = db.prepare(
    `SELECT ${columns
      .map((name) => {
        const column = quoteIdentifier(name);
        return `CASE typeof(${column}) WHEN 'text' THEN length(CAST(${column} AS BLOB)) WHEN 'blob' THEN length(${column}) ELSE 0 END`;
      })
      .join(", ")} FROM ${source} LIMIT ?`,
  );
  lengths.setReturnArrays(true);
  for (const raw of lengths.iterate(limit))
    budget.beforeProjection(z.array(z.bigint().nonnegative()).parse(raw));
  const statement = db.prepare(`SELECT ${projection} FROM ${source} LIMIT ?`);
  statement.setReturnArrays(true);
  const rows: NonNullable<SqliteDatabase["rows"]> = {
    table: input.table,
    columns,
    values: [],
    row_limit: limit,
    returned_rows: 0,
    truncated: false,
    order: "unspecified",
  };
  for (const raw of statement.iterate(limit)) {
    const rawRow = arrayRow.parse(raw);
    // Hex expansion already belongs to the retained-output budget, before decoding/copying cells.
    budget.beforeDecode(rawRow);
    const values = rawRow.map((value) => cell(value, encoding));
    budget.retain(values);
    rows.values.push(values);
  }
  rows.returned_rows = rows.values.length;
  rows.truncated =
    db.prepare(`SELECT 1 FROM ${source} LIMIT 1 OFFSET ?`).get(limit) !==
    undefined;
  return rows;
};

/** Query only a provider-owned snapshot; no caller SQL, extensions, views or virtual rows. */
export const inspectSqliteDatabaseSnapshot = (
  snapshotPath: string,
  input: InspectSqliteDatabaseInput,
): Inspection => {
  const db = new DatabaseSync(snapshotPath, {
    readOnly: true,
    allowExtension: false,
    readBigInts: true,
    enableDoubleQuotedStringLiterals: false,
    timeout: 0,
    limits: {
      length: SQLITE_DATABASE_LIMITS.outputBytes,
      sqlLength: SQLITE_DATABASE_LIMITS.outputBytes,
    },
  });
  try {
    const limits: unknown = db.limits;
    const supported = z
      .object({
        length: z
          .number()
          .int()
          .positive()
          .max(SQLITE_DATABASE_LIMITS.outputBytes),
        sqlLength: z
          .number()
          .int()
          .positive()
          .max(SQLITE_DATABASE_LIMITS.outputBytes),
      })
      .safeParse(limits);
    if (!supported.success)
      throw new SqliteInspectionFailure(
        "unavailable",
        "SQLite inspection requires the native DatabaseSync.limits API to bound untrusted values and SQL. Use Node.js 24.15 or newer in the supported 24.x line, or a compatible Node.js 26+ runtime.",
      );
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA mmap_size=0; PRAGMA cell_size_check=ON; BEGIN;",
    );
    const version = z
      .object({ version: z.string() })
      .parse(db.prepare("SELECT sqlite_version() AS version").get()).version;
    const encoding = z
      .object({ encoding: encodingSchema })
      .parse(db.prepare("PRAGMA encoding").get()).encoding;
    const limitations = [
      "Inspects an offline stable file set. Filesystem identity checks detect observed acquisition changes; they do not establish an atomic snapshot of an actively changing database. Supply an application-created backup or quiescent database/WAL pair.",
      "The source database and WAL are never opened by SQLite or modified. A private copy may acquire its own WAL-index sidecar and is removed after inspection.",
      "SQLite reports current schema and selected committed rows from its valid database/WAL state. Deleted records, uncommitted or invalid WAL tails, encrypted databases, forensic recovery, and full integrity verification are outside this profile.",
      "Stored CREATE statements preserve index/view/trigger definitions. Views, triggers, and virtual/shadow table rows are not executed; virtual-table column expansion is unsupported.",
      "Selected rows have unspecified order and are a bounded sample. Text display may replace invalid sequences; bytes_hex and encoding preserve SQLite's text byte representation, not original on-disk page offsets.",
      "Resource boundaries: combined input 256 MiB, complete worker JSON 16 MiB, native SQLite value/record and SQL statement lengths 16 MiB, owned-worker JavaScript heap 256 MiB and supervised deadline 30 seconds. These are distinct from total resident memory; an overall native SQLite heap cap is not claimed. Failures return no partial success.",
    ];
    const budget = new OutputBudget();
    const schema = readSchema(db, { budget, limitations, encoding });
    return {
      engine: { name: "SQLite", version },
      database_encoding: encoding,
      schema,
      rows: readRows(db, input, schema, { encoding, budget }),
      limitations,
    };
  } finally {
    db.close();
  }
};
