import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, onTestFinished } from "vitest";

import { SQLITE_NATIVE_LIMITS_AVAILABLE } from "../fixtures/sqlite/database.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

cliTest.skipIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "reports the required native SQLite limits capability through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-unavailable-");
    const path = join(root, "selected.db");
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TABLE items(value INTEGER)");
    } finally {
      database.close();
    }
    const result = await cli.run({
      arguments: ["inspect-sqlite-database", path, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("DatabaseSync.limits"),
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_sqlite_database", { path });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("DatabaseSync.limits"),
    });
  },
);

cliTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "accepts small samples above 1000 rows within the real resource budgets",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-row-budget-");
    const path = join(root, "rows.db");
    const database = new DatabaseSync(path);
    try {
      database.exec(`CREATE TABLE items(value INTEGER);
      WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 1002)
      INSERT INTO items SELECT value FROM numbers;`);
    } finally {
      database.close();
    }
    const { call } = await connectLocalToolsMcp();
    for (const limit of [1001, Number.MAX_SAFE_INTEGER]) {
      const result = await cli.run({
        arguments: [
          "inspect-sqlite-database",
          path,
          "--table",
          "items",
          "--row-limit",
          String(limit),
          "--json",
        ],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.json).toMatchObject({
        normalized_result: {
          rows: {
            row_limit: limit,
            returned_rows: Math.min(limit, 1002),
            truncated: limit < 1002,
          },
        },
      });
      const response = await call("inspect_sqlite_database", {
        path,
        table: "items",
        row_limit: limit,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(response.structuredContent).toEqual(result.json);
    }
  },
);

const sourceState = async (path: string) => {
  const bytes = await readFile(path);
  const metadata = await stat(path, { bigint: true });
  return {
    bytes,
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modified: metadata.mtimeNs,
    changed: metadata.ctimeNs,
  };
};

cliTest
  .runIf(SQLITE_NATIVE_LIMITS_AVAILABLE)
  .for(["DELETE", "PERSIST", "TRUNCATE"])(
  "inspects a real %s SQLite schema and lossless selected records identically through CLI and MCP",
  async (journalMode, { cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-public-");
    const path = join(root, "selected.db");
    const database = new DatabaseSync(path);
    try {
      database.exec(`PRAGMA journal_mode=${journalMode}`);
      database.exec(`
      CREATE TABLE "odd "" table" (
        id INTEGER PRIMARY KEY,
        payload BLOB,
        amount REAL,
        missing TEXT,
        text_value TEXT,
        negative_zero,
        generated TEXT GENERATED ALWAYS AS (hex(payload)) VIRTUAL
      );
      CREATE UNIQUE INDEX "quoted "" index" ON "odd "" table"(payload, id);
      CREATE VIEW readable AS SELECT id FROM "odd "" table";
      CREATE TRIGGER observed AFTER INSERT ON "odd "" table" BEGIN SELECT 1; END;
      CREATE TABLE keyed(k TEXT PRIMARY KEY) WITHOUT ROWID, STRICT;
    `);
      const insert = database.prepare(
        'INSERT INTO "odd "" table"(id,payload,amount,missing,text_value,negative_zero) VALUES(?,?,?,NULL,CAST(X\'80ff\' AS TEXT),?)',
      );
      insert.run(
        9007199254740993n,
        Buffer.from("deadbeef", "hex"),
        Infinity,
        -0,
      );
      insert.run(
        9007199254740994n,
        Buffer.from("deadbeef", "hex"),
        Infinity,
        -0,
      );
    } finally {
      database.close();
    }
    const original = await readFile(path);
    const result = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        "selected.db",
        "--table",
        'odd " table',
        "--row-limit",
        "1",
        "--json",
      ],
      cwd: root,
      environment: {
        REA_LOG_LEVEL: "silent",
        REA_ANALYSIS_PROVIDER: "ghidra",
        REA_GHIDRA_HOME: "/unconfigured/ghidra",
      },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      operation: "inspect_sqlite_database",
      confidence: "observed",
      subject: { local_path: path, digest: { sha256: digest(original) } },
      normalized_result: {
        artifact: { path, sha256: digest(original), bytes: original.length },
        wal: null,
        schema: {
          completeness: "complete",
          tables: expect.arrayContaining([
            expect.objectContaining({
              name: 'odd " table',
              columns: expect.arrayContaining([
                expect.objectContaining({
                  name: "id",
                  primary_key_position: 1,
                }),
                expect.objectContaining({ name: "generated", hidden: 2 }),
              ]),
            }),
            expect.objectContaining({
              name: "keyed",
              without_rowid: true,
              strict: true,
            }),
          ]),
          indexes: expect.arrayContaining([
            expect.objectContaining({
              name: 'quoted " index',
              table: 'odd " table',
            }),
          ]),
          views: [
            { name: "readable", sql: expect.stringContaining("SELECT id") },
          ],
          triggers: [
            {
              name: "observed",
              table: 'odd " table',
              sql: expect.stringContaining("AFTER INSERT"),
            },
          ],
        },
        rows: {
          table: 'odd " table',
          columns: [
            "id",
            "payload",
            "amount",
            "missing",
            "text_value",
            "negative_zero",
            "generated",
          ],
          returned_rows: 1,
          row_limit: 1,
          truncated: true,
          values: [
            [
              {
                type: "integer",
                value: expect.stringMatching(/^900719925474099[34]$/),
              },
              { type: "blob", hex: "deadbeef" },
              { type: "real", value: "Infinity" },
              { type: "null" },
              { type: "text", value: "\ufffd\ufffd", bytes_hex: "80ff" },
              { type: "real", value: "-0" },
              {
                type: "text",
                value: "DEADBEEF",
                bytes_hex: "4445414442454546",
              },
            ],
          ],
        },
      },
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_sqlite_database", {
      path,
      table: 'odd " table',
      row_limit: 1,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(response.structuredContent).toEqual(result.json);
    expect(await readFile(path)).toEqual(original);
  },
);

cliTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "includes uncheckpointed committed WAL data without modifying the source database or sidecars",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-wal-public-");
    const path = join(root, "wal.db");
    const database = new DatabaseSync(path);
    onTestFinished(() => database.close());
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE committed(value TEXT); INSERT INTO committed VALUES('only in WAL');",
    );
    const files = [path, `${path}-wal`, `${path}-shm`];
    const before = await Promise.all(files.map(sourceState));
    const db = before[0];
    const wal = before[1];
    expect(db).toBeDefined();
    expect(wal).toBeDefined();
    const result = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        path,
        "--table",
        "committed",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      normalized_result: {
        artifact: { sha256: db === undefined ? "missing" : digest(db.bytes) },
        wal: {
          path: `${path}-wal`,
          sha256: wal === undefined ? "missing" : digest(wal.bytes),
        },
        rows: {
          values: [
            [
              {
                type: "text",
                value: "only in WAL",
                bytes_hex: Buffer.from("only in WAL").toString("hex"),
              },
            ],
          ],
          returned_rows: 1,
          truncated: false,
        },
      },
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_sqlite_database", {
      path,
      table: "committed",
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(response.structuredContent).toEqual(result.json);
    const after = await Promise.all(files.map(sourceState));
    expect(after).toEqual(before);
  },
);

cliTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "returns actionable public errors for corrupt input, unknown or ambiguous tables and invalid record choices",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-errors-public-");
    const path = join(root, "invalid.db");
    await writeFile(path, "not a SQLite database");
    const { call } = await connectLocalToolsMcp();
    const corrupt = await cli.run({
      arguments: ["inspect-sqlite-database", path, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(corrupt.exitCode).toBe(1);
    expect(corrupt.json).toMatchObject({ code: "invalid_request" });
    expect((await call("inspect_sqlite_database", { path })).isError).toBe(
      true,
    );
    const valid = join(root, "valid.db");
    const database = new DatabaseSync(valid);
    try {
      database.exec(
        "CREATE TABLE present(value TEXT); CREATE VIRTUAL TABLE search USING fts5(body);",
      );
    } finally {
      database.close();
    }
    const bytes = await readFile(valid);
    const declaration = bytes.indexOf(Buffer.from("USING fts5"));
    if (declaration < 0) throw new Error("Virtual declaration missing");
    bytes.write("zzzz", declaration + Buffer.byteLength("USING "), "utf8");
    await writeFile(valid, bytes);
    const schema = await call("inspect_sqlite_database", { path: valid });
    expect(schema.isError).not.toBe(true);
    expect(schema.structuredContent).toMatchObject({
      normalized_result: {
        schema: {
          tables: expect.arrayContaining([
            expect.objectContaining({ name: "search_data", kind: "unknown" }),
          ]),
        },
      },
    });
    const ambiguous = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        valid,
        "--table",
        "search_data",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stdout).toContain("shadow table");
    expect(
      (
        await call("inspect_sqlite_database", {
          path: valid,
          table: "search_data",
        })
      ).isError,
    ).toBe(true);
    const missing = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        valid,
        "--table",
        "absent",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("absent");
    expect(
      (await call("inspect_sqlite_database", { path: valid, table: "absent" }))
        .isError,
    ).toBe(true);
    for (const input of [
      { path: valid, row_limit: 1 },
      { path: valid, table: "present", row_limit: 0 },
      { path: valid, query: "DELETE FROM present" },
    ]) {
      expect(
        (await call("inspect_sqlite_database", input)).isError,
        JSON.stringify(input),
      ).toBe(true);
    }
  },
);
