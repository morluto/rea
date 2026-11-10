import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished } from "vitest";

import { readSqliteStateView } from "../../../src/application/desktop/DesktopSqliteState.js";
import { SqliteDatabaseService } from "../../../src/application/sqlite/SqliteDatabaseService.js";
import { SqliteDatabaseProvider } from "../../../src/sqlite/SqliteDatabaseProvider.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import {
  PYTHON_IMPORTS,
  renderPythonHelpers,
} from "../../../src/domain/desktop/appExportPython.js";
import { desktopViewPolicy } from "../../../src/domain/desktop/desktopViewPolicy.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const imports = PYTHON_IMPORTS.split("\n")
  .filter((line) => !line.includes("agentenv_protocol"))
  .join("\n");

/** Execute emitted helpers or an independent oracle using only Python's standard library. */
const python = async (
  scratch: string,
  program: string,
  args: string[] = [],
) => {
  const script = join(scratch, "read.py");
  await writeFile(script, program);
  return execFileSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-B", script, ...args],
    { encoding: "utf8" },
  );
};

/** One real DB and owned worker, read independently through both production readers. */
const sqliteReaders = async (populate: (db: DatabaseSync) => void) => {
  const scratch = await createTestTempDirectory("desktop-sqlite-view-budget-");
  const path = join(scratch, "state.db");
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE healthy(x); INSERT INTO healthy VALUES(1)");
    populate(db);
  } finally {
    db.close();
  }
  const before = await readFile(path);
  const worker = fileURLToPath(
    new URL("../../../dist/sqlite/SqliteDatabaseWorker.js", import.meta.url),
  );
  const provider = new SqliteDatabaseProvider(process.env, (spawn) =>
    spawnOwnedProviderProcess({
      ...spawn,
      arguments: spawn.arguments.map((argument, index) =>
        index === 1 ? worker : argument,
      ),
    }),
  );
  const service = new SqliteDatabaseService(provider);
  onTestFinished(async () => {
    await provider.close();
    expect((await readFile(path)).equals(before)).toBe(true);
  });
  return {
    scratch,
    typescript: async (bytes: number) => {
      const selected = await readSqliteStateView(
        service,
        path,
        undefined,
        desktopViewPolicy({ sqlite_view_bytes: bytes }),
      );
      if (!selected.ok) throw new Error(selected.error);
      return selected.view;
    },
    emitted: async (bytes: number) =>
      JSON.parse(
        await python(
          scratch,
          `${imports}${renderPythonHelpers(desktopViewPolicy({ sqlite_view_bytes: bytes }))}\nprint(json.dumps(_sqlite(Path(sys.argv[1]))))\n`,
          [path],
        ),
      ) as { view: { tables: Record<string, unknown> }; truncated: boolean },
  };
};

it("bounds each projected SQLite table and recovers the same complete facts in both readers", async () => {
  const fixture = await sqliteReaders((db) => {
    db.exec("CREATE TABLE items(value)");
    const insert = db.prepare("INSERT INTO items VALUES(?)");
    insert.run("plain");
    insert.run("\u0000é😀");
    insert.run(Buffer.from([0, 255]));
  });
  // Independent expected JSON includes UTF-8, escaping and blob expansion.
  const expected = {
    columns: ["value"],
    primary_key: [],
    rows: [["plain"], ["\u0000é😀"], [{ blob_hex: "00ff" }]],
    truncated: false,
  };
  const exact = Buffer.byteLength(JSON.stringify(expected));
  for (const bytes of [exact - 1, exact, exact + 1]) {
    const typescript = await fixture.typescript(bytes);
    const emitted = await fixture.emitted(bytes);
    expect(emitted.view).toEqual(typescript);
    expect(emitted.view.tables.healthy).toEqual({
      columns: ["x"],
      primary_key: [],
      rows: [[1]],
      truncated: false,
    });
    expect(emitted.truncated).toBe(bytes < exact);
    expect(emitted.view.tables.items).toEqual(
      bytes < exact
        ? {
            error: expect.stringContaining(
              `sqlite_view_bytes=${String(bytes)} UTF-8 JSON bytes`,
            ),
          }
        : expected,
    );
  }
});

it("counts numeric facts using each reader's native compact JSON spelling", async () => {
  const fixture = await sqliteReaders((db) =>
    db.exec(
      "CREATE TABLE numbers(id INTEGER, whole REAL GENERATED ALWAYS AS (16.0) VIRTUAL, fraction REAL GENERATED ALWAYS AS (0.125) VIRTUAL, small REAL GENERATED ALWAYS AS (1e-7) VIRTUAL, large REAL GENERATED ALWAYS AS (1e20) VIRTUAL, neg REAL GENERATED ALWAYS AS (-0.0) VIRTUAL); INSERT INTO numbers(id) VALUES(1)",
    ),
  );
  // SQLite normalizes this generated -0.0 to zero; explicit signed-zero cell
  // sizing is checked below without claiming the DB retained a missing sign.
  const expected = {
    columns: ["id", "whole", "fraction", "small", "large", "neg"],
    primary_key: [],
    rows: [[1, 16, 0.125, 1e-7, 1e20, 0]],
    truncated: false,
  };
  const typescriptBytes = Buffer.byteLength(JSON.stringify(expected));
  const pythonBytes = Number(
    (
      await python(
        fixture.scratch,
        `import json
expected = {"columns": ["id", "whole", "fraction", "small", "large", "neg"], "primary_key": [], "rows": [[1, 16.0, 0.125, 1e-7, 1e20, 0.0]], "truncated": False}
print(len(json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode("utf-8")))
`,
      )
    ).trim(),
  );
  expect(pythonBytes).not.toBe(typescriptBytes);
  for (const bytes of new Set([
    typescriptBytes - 1,
    typescriptBytes,
    pythonBytes - 1,
    pythonBytes,
  ])) {
    const error = {
      error: expect.stringContaining(`sqlite_view_bytes=${String(bytes)}`),
    };
    expect(await fixture.typescript(bytes)).toMatchObject({
      tables: { numbers: bytes >= typescriptBytes ? expected : error },
    });
    expect((await fixture.emitted(bytes)).view.tables.numbers).toEqual(
      bytes >= pythonBytes ? expected : error,
    );
  }
});

it("keeps the native SQLite record limit independent of a larger view allowance", async () => {
  // A tiny stored declaration expands beyond the native hex/record allowance.
  const fixture = await sqliteReaders((db) =>
    db.exec(
      "CREATE TABLE native_limit(id, payload BLOB GENERATED ALWAYS AS (zeroblob(9 * 1024 * 1024)) VIRTUAL); INSERT INTO native_limit(id) VALUES(1)",
    ),
  );
  const bytes = 32 * 1024 * 1024;
  const emitted = await fixture.emitted(bytes);
  for (const view of [await fixture.typescript(bytes), emitted.view]) {
    expect(view).toMatchObject({
      tables: {
        healthy: { rows: [[1]] },
        native_limit: { error: expect.any(String) },
      },
    });
    expect(JSON.stringify(view)).not.toContain("exceeds sqlite_view_bytes");
  }
  expect(emitted.view.tables.native_limit).toEqual({
    error: expect.stringContaining("string or blob too big"),
  });
  const nativeError = (emitted.view.tables.native_limit as { error: string })
    .error;
  expect(nativeError).toContain("fixed 16777216-byte native limit");
  expect(nativeError).toContain(
    "Increasing sqlite_view_bytes does not raise this boundary",
  );
  expect(nativeError).toContain("Keep the complete database");
  expect(nativeError).toContain("only if it preserves the required facts");
  expect(nativeError).not.toContain("Increase sqlite_view_bytes");
  expect(emitted.truncated).toBe(true);
});

it("refuses escaped cell overflow without allocating its full JSON spelling", async () => {
  const scratch = await createTestTempDirectory("desktop-sqlite-json-parts-");
  const result = JSON.parse(
    await python(
      scratch,
      `${imports}${renderPythonHelpers(desktopViewPolicy())}
import tracemalloc
value = chr(1) * 1048576
tracemalloc.start()
size = _view_json_bytes({"rows": [[value]]}, 1024)
negative_zero = _view_json_bytes(_cell(-0.0, "utf-8"), 1024)
_, peak = tracemalloc.get_traced_memory()
tracemalloc.stop()
print(json.dumps({"size": size, "peak": peak, "negative_zero": negative_zero}))
`,
    ),
  ) as { size: number; peak: number; negative_zero: number };
  expect(result.size).toBeGreaterThan(1024);
  expect(result.negative_zero).toBe(Buffer.byteLength(JSON.stringify("-0")));
  // Input exists before tracing. Whole-cell quoting previously made a six-MiB
  // string merely to reject this one-KiB allowance.
  expect(result.peak).toBeLessThan(1024 * 1024);
});
