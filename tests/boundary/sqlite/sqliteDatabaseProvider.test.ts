import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it as nativeTest, onTestFinished } from "vitest";
import { SqliteDatabaseProvider } from "../../../src/sqlite/SqliteDatabaseProvider.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { waitForProviderProcessReady } from "../../fixtures/providerProcess.js";
import {
  createSqliteDatabaseFixture,
  SQLITE_NATIVE_LIMITS_AVAILABLE,
} from "../../fixtures/sqlite/database.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const it = nativeTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE);

const workerUrl = new URL(
  "../../../dist/sqlite/SqliteDatabaseWorker.js",
  import.meta.url,
);
const createProvider = () =>
  new SqliteDatabaseProvider(process.env, (spawn) =>
    spawnOwnedProviderProcess({
      ...spawn,
      arguments: spawn.arguments.map((argument, index) =>
        index === 1 ? fileURLToPath(workerUrl) : argument,
      ),
    }),
  );

const createFixture = async (wal = false) => {
  const workspace = await createTestWorkspace("rea-sqlite-boundary-");
  const database = createSqliteDatabaseFixture(workspace.root, wal);
  if (!wal) database.close();
  onTestFinished(async () => {
    if (wal) database.close();
    await removeTestWorkspace(workspace.root);
  });
  return { workspace, database };
};

it("inspects committed WAL schema and rows while preserving every source artifact", async () => {
  const { database } = await createFixture(true);
  const paths = [database.path, database.walPath, `${database.path}-shm`];
  const original = await Promise.all(
    paths.map(async (path) => ({
      path,
      bytes: await readFile(path),
      stat: await lstat(path),
    })),
  );
  const result = await createProvider().inspect({
    path: database.path,
    table: "records",
    row_limit: 1,
  });
  if (!result.ok) throw result.error;
  const main = original[0];
  const wal = original[1];
  if (main === undefined || wal === undefined)
    throw new Error("Missing fixture identity");
  expect(result.value.result).toMatchObject({
    artifact: {
      path: database.path,
      bytes: main.bytes.length,
      sha256: createHash("sha256").update(main.bytes).digest("hex"),
    },
    wal: {
      path: database.walPath,
      bytes: wal.bytes.length,
      sha256: createHash("sha256").update(wal.bytes).digest("hex"),
    },
    schema: {
      completeness: "complete",
      tables: expect.arrayContaining([
        {
          name: "records",
          sql: expect.stringContaining("CREATE TABLE"),
          root_page: expect.any(Number),
          kind: "table",
          without_rowid: false,
          strict: false,
          columns_completeness: "complete",
          columns: expect.arrayContaining([
            expect.objectContaining({ name: "generated_value", hidden: 2 }),
          ]),
        },
      ]),
      indexes: [
        expect.objectContaining({ name: "records_text", table: "records" }),
      ],
      views: [
        {
          name: "record_names",
          sql: expect.stringContaining("SELECT text_value"),
        },
      ],
      triggers: [
        {
          name: "records_insert",
          table: "records",
          sql: expect.stringContaining("AFTER INSERT"),
        },
      ],
    },
    rows: {
      table: "records",
      returned_rows: 1,
      truncated: true,
      row_limit: 1,
      order: "unspecified",
    },
  });
  for (const artifact of original) {
    expect(await readFile(artifact.path)).toEqual(artifact.bytes);
    const after = await lstat(artifact.path);
    expect({
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    }).toEqual({
      ino: artifact.stat.ino,
      size: artifact.stat.size,
      mtimeMs: artifact.stat.mtimeMs,
      ctimeMs: artifact.stat.ctimeMs,
    });
  }
});

it("preserves SQLite integer, binary, nonfinite, null, and text byte values", async () => {
  const { database } = await createFixture();
  const result = await createProvider().inspect({
    path: database.path,
    table: "records",
    row_limit: 10,
  });
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    wal: null,
    rows: {
      columns: [
        "id",
        "integer_value",
        "blob_value",
        "real_value",
        "nullable_value",
        "text_value",
        "generated_value",
      ],
      returned_rows: 3,
      truncated: false,
      values: [
        [
          { type: "integer", value: "1" },
          { type: "integer", value: "9223372036854775807" },
          { type: "blob", hex: "001fefff" },
          { type: "real", value: "Infinity" },
          { type: "null" },
          {
            type: "text",
            value: "first é\0value",
            bytes_hex: Buffer.from("first é\0value").toString("hex"),
          },
          {
            type: "text",
            value: "integer",
            bytes_hex: Buffer.from("integer").toString("hex"),
          },
        ],
        [
          { type: "integer", value: "2" },
          { type: "integer", value: "-9223372036854775808" },
          { type: "blob", hex: "" },
          { type: "real", value: "-Infinity" },
          {
            type: "text",
            value: "present",
            bytes_hex: Buffer.from("present").toString("hex"),
          },
          {
            type: "text",
            value: "second",
            bytes_hex: Buffer.from("second").toString("hex"),
          },
          {
            type: "text",
            value: "integer",
            bytes_hex: Buffer.from("integer").toString("hex"),
          },
        ],
        [
          { type: "integer", value: "3" },
          { type: "integer", value: "0" },
          { type: "blob", hex: "ff" },
          { type: "real", value: 1.25 },
          { type: "null" },
          { type: "text", bytes_hex: "ff00c0af" },
          {
            type: "text",
            value: "integer",
            bytes_hex: Buffer.from("integer").toString("hex"),
          },
        ],
      ],
    },
  });
  expect(() => JSON.stringify(result.value.result)).not.toThrow();
});

it("selects an exact quoted table and refuses to execute table input as SQL", async () => {
  const { database } = await createFixture();
  const provider = createProvider();
  const selected = await provider.inspect({
    path: database.path,
    table: database.quotedTable,
    row_limit: 1,
  });
  if (!selected.ok) throw selected.error;
  expect(selected.value.result).toMatchObject({
    rows: {
      table: database.quotedTable,
      columns: ["__proto__"],
      values: [
        [
          {
            type: "text",
            value: "exact selected table",
            bytes_hex: Buffer.from("exact selected table").toString("hex"),
          },
        ],
      ],
      returned_rows: 1,
      truncated: false,
    },
  });
  const unknown = await provider.inspect({
    path: database.path,
    table: 'records"; DROP TABLE records;--',
    row_limit: 1,
  });
  expect(unknown).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  const after = await provider.inspect({
    path: database.path,
    table: "records",
    row_limit: 10,
  });
  if (!after.ok) throw after.error;
  expect(after.value.result).toMatchObject({ rows: { returned_rows: 3 } });
});

it("does not execute views when selecting rows", async () => {
  const { database } = await createFixture();
  const result = await createProvider().inspect({
    path: database.path,
    table: "record_names",
    row_limit: 1,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("rejects malformed databases without altering the selected file", async () => {
  const workspace = await createTestWorkspace("rea-sqlite-invalid-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = await workspace.write(
    "not-a-database.db",
    "selected non-SQLite bytes",
  );
  const bytes = await readFile(path);
  const result = await createProvider().inspect({ path });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(await readFile(path)).toEqual(bytes);
});

nativeTest.runIf(process.platform !== "win32")(
  "rejects a symlink database",
  async () => {
    const { database, workspace } = await createFixture();
    const alias = workspace.path("alias.db");
    await symlink(database.path, alias);
    const provider = createProvider();
    expect(await provider.inspect({ path: alias })).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  },
);

nativeTest(
  "rejects an actual open rollback transaction without changing its journal",
  async () => {
    const { database } = await createFixture();
    const writer = new DatabaseSync(database.path);
    writer.exec(
      "BEGIN IMMEDIATE; INSERT INTO records(id, text_value) VALUES (4, 'uncommitted')",
    );
    try {
      const main = await readFile(database.path);
      const journalPath = `${database.path}-journal`;
      const journal = await readFile(journalPath);
      expect(journal.length).toBeGreaterThan(0);
      expect(
        await createProvider().inspect({ path: database.path }),
      ).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
      expect(await readFile(database.path)).toEqual(main);
      expect(await readFile(journalPath)).toEqual(journal);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  },
);

nativeTest.runIf(process.platform !== "win32")(
  "rejects FIFO input without waiting for a writer",
  async () => {
    const workspace = await createTestWorkspace("rea-sqlite-fifo-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const path = workspace.path("database.fifo");
    await promisify(execFile)("mkfifo", [path]);
    const result = await createProvider().inspect({ path });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  },
);

nativeTest(
  "honors a cancelled caller before opening the database",
  async () => {
    const { database } = await createFixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await createProvider().inspect(
        { path: database.path },
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  },
);

nativeTest(
  "removes an acquired private root when cancelled before snapshot creation",
  async () => {
    const { database } = await createFixture();
    const controller = new AbortController();
    let ownedRoot = "";
    const provider = new SqliteDatabaseProvider(
      {},
      () => {
        throw new Error("Cancelled request must not launch SQLite");
      },
      async () => {
        const root = await PrivateRuntimeRoot.create({
          prefix: "rea-sqlite-cancel-root-",
        });
        ownedRoot = root.path;
        controller.abort();
        return root;
      },
    );
    expect(
      await provider.inspect(
        { path: database.path },
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
  "preserves %s text, a leading BOM and empty table selection",
  async (encoding) => {
    const workspace = await createTestWorkspace("rea-sqlite-encoding-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const path = workspace.path("encoding.db");
    const writer = new DatabaseSync(path);
    writer.exec(
      `PRAGMA encoding='${encoding}'; CREATE TABLE "" ("1" TEXT, "0" TEXT)`,
    );
    const value = "\uFEFFé𝄞\0selected";
    writer
      .prepare('INSERT INTO "" VALUES (?, ?)')
      .run(value, "second numeric column");
    writer.close();
    const bytes = Buffer.from(value, encoding === "UTF-8" ? "utf8" : "utf16le");
    if (encoding === "UTF-16be") bytes.swap16();
    const result = await createProvider().inspect({
      path,
      table: "",
    });
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({
      database_encoding: encoding,
      rows: {
        table: "",
        columns: ["1", "0"],
        returned_rows: 1,
        values: [
          [
            { type: "text", value, bytes_hex: bytes.toString("hex"), encoding },
            { type: "text", value: "second numeric column" },
          ],
        ],
      },
    });
  },
);

it("retains an unavailable virtual module definition without executing it", async () => {
  const workspace = await createTestWorkspace("rea-sqlite-virtual-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = workspace.path("virtual.db");
  const writer = new DatabaseSync(path);
  writer.exec(
    "CREATE VIRTUAL TABLE optional_search USING fts5(body); INSERT INTO optional_search VALUES ('selected source')",
  );
  writer.close();
  const bytes = await readFile(path);
  const declaration = bytes.indexOf(Buffer.from("USING fts5"));
  if (declaration < 0)
    throw new Error("SQLite virtual module declaration not found");
  bytes.write("zzzz", declaration + Buffer.byteLength("USING "), "utf8");
  await writeFile(path, bytes);
  const provider = createProvider();
  const result = await provider.inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    rows: null,
    schema: {
      tables: expect.arrayContaining([
        expect.objectContaining({
          name: "optional_search",
          kind: "virtual",
          sql: expect.stringContaining("USING zzzz"),
          columns: [],
          columns_completeness: "unsupported",
        }),
      ]),
    },
  });
  expect(
    await provider.inspect({ path, table: "optional_search" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  expect(await readFile(path)).toEqual(bytes);
});

nativeTest(
  "cancels an acquired SQLite worker and removes its private snapshot",
  async () => {
    const { database } = await createFixture();
    const controller = new AbortController();
    let ownedRoot = "";
    let pid: number | undefined;
    const provider = new SqliteDatabaseProvider({}, async (spawn) => {
      ownedRoot = spawn.cwd ?? "";
      const requestPath = spawn.arguments[2];
      if (requestPath === undefined)
        throw new Error("SQLite worker arguments missing");
      const launched = await spawnOwnedProviderProcess({
        ...spawn,
        arguments: [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(workerUrl.href)}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
          "sqlite-worker-test",
          requestPath,
        ],
      });
      pid = launched.process.pid;
      await waitForProviderProcessReady(launched.process);
      await access(`${ownedRoot}/reply.json`);
      setImmediate(() => controller.abort());
      return launched;
    });
    const result = await provider.inspect(
      { path: database.path, table: "records" },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    if (pid === undefined) throw new Error("SQLite worker not acquired");
    const acquiredPid = pid;
    expect(() => process.kill(acquiredPid, 0)).toThrow();
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
