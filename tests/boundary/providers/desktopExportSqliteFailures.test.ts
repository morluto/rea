import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import { evaluateTaskChecks } from "../../../src/domain/desktop/appTaskChecks.js";
import { PYTHON_TASK_EVALUATOR } from "../../../src/domain/desktop/appTaskPython.js";
import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const file = "Documents/state.db";
const checks: readonly DesktopTaskCheck[] = [
  {
    id: "healthy-row",
    kind: "row_present",
    file,
    table: "good",
    where: { mode: "done" },
  },
  {
    id: "healthy-value",
    kind: "value_equals",
    file,
    pointer: "/tables/good/rows/0/0",
    value: "done",
  },
  { id: "healthy-count", kind: "row_count", file, table: "good", equals: 1 },
  {
    id: "unknown-absence",
    kind: "row_absent",
    file,
    table: "bad",
    where: { n: 0 },
  },
  { id: "unknown-count", kind: "row_count", file, table: "bad", equals: 0 },
];

it.each([true, false])(
  "keeps healthy SQLite tables when a row query fails (bad first: %s)",
  async (badFirst) => {
    const root = await createTestTempDirectory("desktop-sqlite-table-failure-");
    await mkdir(join(root, "Documents"));
    const path = join(root, file);
    const db = new DatabaseSync(path);
    try {
      // Model an app's abs() returning REAL for the minimum int64. Plain SQLite's
      // builtin throws on that value after reopening; the schema stays readable.
      db.function(
        "abs",
        { deterministic: true, useBigIntArguments: true },
        (value) => Math.abs(Number(value)),
      );
      const good = "CREATE TABLE good(mode TEXT)";
      const bad =
        "CREATE TABLE bad(n INTEGER, magnitude INTEGER GENERATED ALWAYS AS(abs(n)) VIRTUAL)";
      db.exec(badFirst ? `${bad};${good}` : `${good};${bad}`);
      db.prepare("INSERT INTO good VALUES (?)").run("done");
      db.prepare("INSERT INTO bad(n) VALUES (?)").run(-9223372036854775808n);
    } finally {
      db.close();
    }
    const oracle = new DatabaseSync(path, { readOnly: true });
    try {
      expect(oracle.prepare("SELECT mode FROM good").get()?.mode).toBe("done");
      let failure: unknown;
      try {
        oracle.prepare("SELECT magnitude FROM bad").all();
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 1 });
    } finally {
      oracle.close();
    }
    const expected = [true, true, true, false, false];
    const native = evaluateTaskChecks(
      checks,
      new Map([
        [
          file,
          {
            format: "sqlite",
            view: {
              tables: {
                good: {
                  columns: ["mode"],
                  primary_key: [],
                  rows: [["done"]],
                  truncated: false,
                },
                bad: { error: "row query failed" },
              },
              tables_truncated: false,
            },
          },
        ],
      ]),
    );
    expect(native.map(({ passed }) => passed)).toEqual(expected);
    const imports = PYTHON_IMPORTS.split("\n")
      .filter((line) => !line.includes("agentenv_protocol"))
      .join("\n");
    const script = join(root, "read-tables.py");
    await writeFile(
      script,
      `${imports}${PYTHON_HELPERS}${PYTHON_TASK_EVALUATOR}
checks = json.load(sys.stdin)
views = _views(Path(sys.argv[1]), ["Documents/state.db"])
print(json.dumps({"entry": views["Documents/state.db"], "results": evaluate(checks, views)}))
`,
    );
    const before = await readFile(path);
    const output = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "python" : "python3",
        ["-I", "-B", "-X", "utf8", script, root],
        { input: JSON.stringify(checks), encoding: "utf8" },
      ),
    ) as {
      entry: {
        format: string;
        truncated: boolean;
        view: {
          tables: { good: unknown; bad: { error: string } };
          tables_truncated: boolean;
        };
      };
      results: { id: string; result: boolean }[];
    };
    expect(output.entry.format).toBe("sqlite");
    expect(output.entry.view.tables.good).toEqual({
      columns: ["mode"],
      primary_key: [],
      rows: [["done"]],
      truncated: false,
    });
    expect(output.entry.view.tables.bad.error.length).toBeGreaterThan(0);
    expect(output.entry.view.tables.bad).not.toHaveProperty("rows");
    expect(output.entry.view.tables_truncated).toBe(false);
    expect(output.entry.truncated).toBe(true);
    expect(output.results.map(({ id, result }) => [id, result])).toEqual(
      native.map(({ id, passed }) => [id, passed]),
    );
    expect(output.results.map(({ result }) => result)).toEqual(expected);
    expect((await readFile(path)).equals(before)).toBe(true);
  },
);
