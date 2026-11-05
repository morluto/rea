import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { PYTHON_TASK_EVALUATOR } from "../../../src/domain/desktop/appTaskPython.js";
import { inspectSqliteDatabaseSnapshot } from "../../../src/sqlite/SqliteDatabaseInspection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["table", "pragma_table_list"],
  ["table", "pragma_table_info"],
  ["view", "pragma_table_list"],
  ["view", "pragma_table_info"],
] as const)(
  "reads exported SQLite state when a %s shadows %s",
  async (kind, name) => {
    const root = await createTestTempDirectory("desktop-sqlite-metadata-");
    const path = join(root, "state.db");
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        CREATE TABLE notes(id INTEGER, part TEXT, "body "" text" TEXT, PRIMARY KEY(part, id));
        INSERT INTO notes VALUES(7, 'a', 'retained');
        ${
          kind === "table"
            ? `CREATE TABLE ${name}(name TEXT, type TEXT, schema TEXT);
               INSERT INTO ${name} VALUES('notes', 'view', 'main');`
            : `CREATE VIEW ${name} AS SELECT missing_function() AS name, 'table' AS type, 'main' AS schema;`
        }
      `);
    } finally {
      db.close();
    }
    const before = await readFile(path);
    const imports = PYTHON_IMPORTS.split("\n")
      .filter((line) => !line.includes("agentenv_protocol"))
      .join("\n");
    const program = join(root, "read.py");
    await writeFile(
      program,
      `${imports}${PYTHON_HELPERS}${PYTHON_TASK_EVALUATOR}
views = _views(Path(sys.argv[1]), ["state.db"])
checks = [{"id": "row", "kind": "row_present", "file": "state.db", "table": "notes", "where": {"id": 7}}]
missing = [{**checks[0], "where": {"id": 8}}]
print(json.dumps({"views": views, "results": evaluate(checks + missing, views)}))
`,
    );
    const output = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "python" : "python3",
        ["-I", "-B", program, root],
        { encoding: "utf8" },
      ),
    ) as {
      views: Record<string, { format: string; view: { tables: unknown } }>;
      results: { result: boolean }[];
    };

    expect(output.views["state.db"]).toMatchObject({
      format: "sqlite",
      truncated: false,
      view: {
        tables_truncated: false,
      },
    });
    expect(output.results.map(({ result }) => result)).toEqual([true, false]);
    expect(output.views["state.db"]?.view.tables).toEqual({
      notes: {
        columns: ["id", "part", 'body " text'],
        primary_key: ["part", "id"],
        rows: [[7, "a", "retained"]],
        truncated: false,
      },
      ...(kind === "table"
        ? {
            [name]: {
              columns: ["name", "type", "schema"],
              primary_key: [],
              rows: [["notes", "view", "main"]],
              truncated: false,
            },
          }
        : {}),
    });
    expect(
      inspectSqliteDatabaseSnapshot(path, { path, table: "notes" }).rows,
    ).toMatchObject({
      columns: ["id", "part", 'body " text'],
      values: [
        [
          { type: "integer", value: "7" },
          { type: "text", value: "a" },
          { type: "text", value: "retained" },
        ],
      ],
    });
    expect((await readFile(path)).equals(before)).toBe(true);
  },
);
