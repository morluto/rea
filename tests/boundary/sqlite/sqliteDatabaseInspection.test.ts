import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it as nativeTest, onTestFinished } from "vitest";
import { SQLITE_NATIVE_LIMITS_AVAILABLE } from "../../fixtures/sqlite/database.js";
import { inspectSqliteDatabaseSnapshot } from "../../../src/sqlite/SqliteDatabaseInspection.js";
import { SqliteInspectionFailure } from "../../../src/sqlite/SqliteDatabaseLimits.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const it = nativeTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE);

const createDatabase = async (sql: string): Promise<string> => {
  const workspace = await createTestWorkspace("rea-sqlite-expansion-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = workspace.path("private.db");
  const producer = new DatabaseSync(path);
  try {
    producer.exec(sql);
  } finally {
    producer.close();
  }
  return path;
};

it("preserves negative-zero REAL values through JSON separately from positive and integer zero", async () => {
  const path = await createDatabase(`
    CREATE TABLE numbers(value);
    INSERT INTO numbers VALUES (-0.0), (0.0), (0), (5e-324), (-5e-324);
  `);
  const result = inspectSqliteDatabaseSnapshot(path, {
    path,
    table: "numbers",
  });
  expect(JSON.parse(JSON.stringify(result.rows))).toMatchObject({
    values: [
      [{ type: "real", value: "-0" }],
      [{ type: "real", value: 0 }],
      [{ type: "integer", value: "0" }],
      [{ type: "real", value: Number.MIN_VALUE }],
      [{ type: "real", value: -Number.MIN_VALUE }],
    ],
  });
});

it.each(["table", "view"] as const)(
  "inspects columns when a %s shadows the table-valued PRAGMA name",
  async (kind) => {
    const path = await createDatabase(`
      CREATE TABLE "selected "" table" ("0" TEXT, "" INTEGER);
      INSERT INTO "selected "" table" VALUES ('retained', 7);
      ${kind === "table" ? "CREATE TABLE pragma_table_xinfo(value TEXT)" : "CREATE VIEW pragma_table_xinfo AS SELECT 1"};
    `);
    const result = inspectSqliteDatabaseSnapshot(path, {
      path,
      table: 'selected " table',
    });
    expect(result.schema.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'selected " table',
          columns: [
            expect.objectContaining({ name: "0", declared_type: "TEXT" }),
            expect.objectContaining({ name: "", declared_type: "INTEGER" }),
          ],
        }),
      ]),
    );
    expect(result.rows).toMatchObject({
      columns: ["0", ""],
      values: [
        [
          { type: "text", value: "retained" },
          { type: "integer", value: "7" },
        ],
      ],
    });
  },
);

it.each([6, 9])(
  "preserves a %i MiB schema statement without expanding its native record",
  async (mebibytes) => {
    const trigger = `CREATE TRIGGER large_definition AFTER INSERT ON records BEGIN /*${"x".repeat(mebibytes * 1024 * 1024)}*/ SELECT 1; END`;
    const path = await createDatabase(`
      CREATE TABLE records(value TEXT);
      ${trigger};
    `);
    const result = inspectSqliteDatabaseSnapshot(path, { path });
    expect(result.schema.triggers).toEqual([
      { name: "large_definition", table: "records", sql: trigger },
    ]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      16 * 1024 * 1024,
    );
  },
);

it("inspects a large schema identifier without expanding a native sort record", async () => {
  const name = "x".repeat(4 * 1024 * 1024);
  const sql = `CREATE TABLE "${name}" (value TEXT)`;
  const path = await createDatabase(sql);
  const result = inspectSqliteDatabaseSnapshot(path, { path });
  expect(result.schema.tables).toMatchObject([
    { name, sql, columns: [{ name: "value", declared_type: "TEXT" }] },
  ]);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
    16 * 1024 * 1024,
  );
});

it.each(["UTF-8", "UTF-16le", "UTF-16be"])(
  "preserves exact %s schema text when decoding native bytes",
  async (encoding) => {
    const sql = 'CREATE TABLE "\uFEFFé𝄞" ("列" TEXT DEFAULT \'\uFEFFvalue\')';
    const path = await createDatabase(`PRAGMA encoding='${encoding}'; ${sql}`);
    const result = inspectSqliteDatabaseSnapshot(path, { path });
    expect(result.schema.tables).toMatchObject([
      {
        name: "\uFEFFé𝄞",
        sql,
        columns: [{ name: "列", default_sql: "'\uFEFFvalue'" }],
      },
    ]);
  },
);

it("counts schema names once when enforcing the complete reply budget", async () => {
  const names = Array.from(
    { length: 48 },
    (_, index) => `${index}_${"x".repeat(128 * 1024)}`,
  );
  const path = await createDatabase(
    names.map((name) => `CREATE TABLE "${name}" (value TEXT);`).join("\n"),
  );
  const result = inspectSqliteDatabaseSnapshot(path, { path });
  expect(result.schema.tables).toHaveLength(names.length);
  expect(result.schema.tables.map((table) => table.name)).toEqual(
    expect.arrayContaining(names),
  );
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
    16 * 1024 * 1024,
  );
});

it("rejects malformed schema bytes instead of returning replacement text", async () => {
  const path = await createDatabase(
    "CREATE TABLE records(value TEXT /*schema-marker*/)",
  );
  const bytes = await readFile(path);
  const marker = bytes.indexOf(Buffer.from("schema-marker"));
  if (marker < 0) throw new Error("Schema marker missing");
  bytes[marker] = 0xff;
  await writeFile(path, bytes);
  expect(() => inspectSqliteDatabaseSnapshot(path, { path })).toThrow(
    /schema sql contains malformed UTF-8 text/,
  );
});

it("refuses possible shadow tables when their virtual module is unavailable", async () => {
  const path = await createDatabase(`
    CREATE VIRTUAL TABLE "SeArCh_É" USING fts5(body);
    INSERT INTO "SeArCh_É" VALUES ('retained');
    CREATE TABLE "search_É_manual" (value TEXT);
    CREATE TABLE "search_é_manual" (value TEXT);
    INSERT INTO "search_é_manual" VALUES ('distinct Unicode name');
    CREATE TABLE "SeArCh_Élite" (value TEXT);
  `);
  const bytes = await readFile(path);
  const declaration = bytes.indexOf(Buffer.from("USING fts5"));
  if (declaration < 0) throw new Error("Virtual declaration missing");
  bytes.write("zzzz", declaration + Buffer.byteLength("USING "), "utf8");
  await writeFile(path, bytes);

  for (const table of ["SeArCh_É_data", "search_É_manual"])
    expect(() => inspectSqliteDatabaseSnapshot(path, { path, table })).toThrow(
      /cannot determine.*shadow table/i,
    );
  const result = inspectSqliteDatabaseSnapshot(path, {
    path,
    table: "search_é_manual",
  });
  expect(result.schema.tables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "SeArCh_É", kind: "virtual" }),
      expect.objectContaining({ name: "SeArCh_É_data", kind: "unknown" }),
      expect.objectContaining({ name: "search_É_manual", kind: "unknown" }),
      expect.objectContaining({ name: "search_é_manual", kind: "table" }),
      expect.objectContaining({ name: "SeArCh_Élite", kind: "table" }),
    ]),
  );
  expect(result.rows).toMatchObject({
    values: [[{ type: "text", value: "distinct Unicode name" }]],
  });
  expect(result.limitations.join("\n")).toMatch(/shadow table/i);
});

it("rejects an oversized generated cell through SQLite's native value limit", async () => {
  const path = await createDatabase(`
    CREATE TABLE records (
      id INTEGER,
      payload BLOB GENERATED ALWAYS AS (zeroblob(72 * 1024 * 1024)) VIRTUAL
    );
    INSERT INTO records(id) VALUES (1);
  `);
  try {
    inspectSqliteDatabaseSnapshot(path, {
      path,
      table: "records",
      row_limit: 1,
    });
    throw new Error("An oversized generated cell must not be projected");
  } catch (cause: unknown) {
    expect(cause).toMatchObject({
      code: "ERR_SQLITE_ERROR",
      errcode: 18,
    });
  }
});

it("reports additional rows without expanding an unselected generated cell", async () => {
  const path = await createDatabase(`
    CREATE TABLE records (
      id INTEGER,
      payload BLOB GENERATED ALWAYS AS (
        CASE WHEN id = 2 THEN zeroblob(72 * 1024 * 1024) ELSE X'01' END
      ) VIRTUAL
    );
    INSERT INTO records(id) VALUES (1), (2);
  `);
  const result = inspectSqliteDatabaseSnapshot(path, {
    path,
    table: "records",
    row_limit: 1,
  });
  expect(result.rows).toMatchObject({
    columns: ["id", "payload"],
    values: [
      [
        { type: "integer", value: "1" },
        { type: "blob", hex: "01" },
      ],
    ],
    returned_rows: 1,
    truncated: true,
  });
});

it("rejects the combined representation of individually small generated cells", async () => {
  const columns = Array.from(
    { length: 6 },
    (_, index) =>
      `payload_${String(index)} BLOB GENERATED ALWAYS AS (zeroblob(2 * 1024 * 1024)) VIRTUAL`,
  );
  const path = await createDatabase(`
    CREATE TABLE records (id INTEGER, ${columns.join(", ")});
    INSERT INTO records(id) VALUES (1);
  `);
  try {
    inspectSqliteDatabaseSnapshot(path, {
      path,
      table: "records",
      row_limit: 1,
    });
    throw new Error(
      "Aggregate row expansion must be rejected before projection",
    );
  } catch (cause: unknown) {
    expect(cause).toBeInstanceOf(SqliteInspectionFailure);
    expect(cause).toMatchObject({ reason: "output-limit" });
  }
});

it("samples above 1000 rows and safe integer limits within the byte budget", async () => {
  const path = await createDatabase(`CREATE TABLE items(value INTEGER);
    WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 1002)
    INSERT INTO items SELECT value FROM numbers;`);
  for (const row_limit of [1001, Number.MAX_SAFE_INTEGER]) {
    const result = inspectSqliteDatabaseSnapshot(path, {
      path,
      table: "items",
      row_limit,
    });
    expect(result.rows).toMatchObject({
      row_limit,
      returned_rows: Math.min(row_limit, 1002),
      truncated: row_limit < 1002,
    });
  }
});

nativeTest.skipIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "rejects a runtime without native limits before querying the snapshot",
  async () => {
    const path = await createDatabase("CREATE TABLE items(value INTEGER)");
    expect(() => inspectSqliteDatabaseSnapshot(path, { path })).toThrow(
      "DatabaseSync.limits",
    );
  },
);
