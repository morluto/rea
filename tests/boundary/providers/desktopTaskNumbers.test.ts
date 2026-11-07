import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import { parseDesktopTask } from "../../../src/domain/desktop/appTask.js";
import { isPortableBundleName } from "../../../src/application/environment/environmentBundle.js";
import { evaluateTaskChecks } from "../../../src/domain/desktop/appTaskChecks.js";
import { renderTaskVerifier } from "../../../src/domain/desktop/appTaskPython.js";
import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// This JSON spelling and its binary64 value are not the same Python integer.
const large = Number("1000000000000000100");
const integer = Number.MAX_SAFE_INTEGER;
const file = "numbers.db";
const pointer = (index: number) => `/tables/samples/rows/0/${String(index)}`;
const expected = [
  true,
  true,
  true,
  false,
  true,
  true,
  true,
  true,
  true,
  false,
  false,
  true,
  false,
  false,
];
const admitted = parseDesktopTask(
  {
    name: "keep-numbers",
    prompt: "Keep the requested measurement and its allowed range.",
    checks: [
      {
        id: "exact",
        kind: "value_equals",
        file,
        pointer: pointer(0),
        value: large,
      },
      {
        id: "nested",
        kind: "value_equals",
        file,
        pointer: "/tables/samples/rows/0",
        value: [large, integer, 2.5, { integer: "9007199254740993" }],
      },
      {
        id: "present",
        kind: "row_present",
        file,
        table: "samples",
        where: { real_value: large },
      },
      {
        id: "absent",
        kind: "row_absent",
        file,
        table: "samples",
        where: { real_value: large },
      },
      {
        id: "count",
        kind: "row_count",
        file,
        table: "samples",
        where: { real_value: large },
        equals: 1,
      },
      {
        id: "difference",
        kind: "value_equals",
        file,
        pointer: pointer(1),
        value: -2,
        tolerance: 2 ** 53,
      },
      {
        id: "tolerance",
        kind: "value_equals",
        file,
        pointer: pointer(0),
        value: 0,
        tolerance: large,
      },
      {
        id: "zero-tolerance",
        kind: "value_equals",
        file,
        pointer: pointer(0),
        value: large,
        tolerance: 0,
      },
      {
        id: "fraction",
        kind: "value_equals",
        file,
        pointer: pointer(2),
        value: 2.5,
      },
      {
        id: "boolean",
        kind: "value_equals",
        file,
        pointer: pointer(2),
        value: true,
      },
      {
        id: "string",
        kind: "value_equals",
        file,
        pointer: pointer(2),
        value: "2.5",
      },
      {
        id: "tagged",
        kind: "value_equals",
        file,
        pointer: pointer(3),
        value: { integer: "9007199254740993" },
      },
      {
        id: "distinct-tagged",
        kind: "value_equals",
        file,
        pointer: pointer(3),
        value: { integer: "9007199254740992" },
      },
      {
        id: "distinct-number",
        kind: "value_equals",
        file,
        pointer: pointer(0),
        value: large + 128,
      },
    ],
  },
  isPortableBundleName,
);
if (!admitted.ok) throw new Error(admitted.error);
const task = admitted.value;

it("grades SQLite REAL values and numeric tolerances as REA's doubles do", async () => {
  const root = await createTestTempDirectory("desktop-task-numbers-");
  const path = join(root, "numbers.db");
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TABLE samples(real_value REAL, integer_value INTEGER, fraction REAL, wide INTEGER)",
    );
    db.prepare("INSERT INTO samples VALUES (?,?,?,?)").run(
      large,
      integer,
      2.5,
      9007199254740993n,
    );
    const statement = db.prepare(
      "SELECT real_value, integer_value, fraction, wide FROM samples",
    );
    statement.setReadBigInts(true);
    expect(statement.get()).toMatchObject({
      real_value: large,
      integer_value: BigInt(integer),
      fraction: 2.5,
      wide: 9007199254740993n,
    });
  } finally {
    db.close();
  }
  const view = {
    tables: {
      samples: {
        columns: ["real_value", "integer_value", "fraction", "wide"],
        primary_key: [],
        rows: [[large, integer, 2.5, { integer: "9007199254740993" }]],
        truncated: false,
      },
    },
    tables_truncated: false,
  };
  const native = evaluateTaskChecks(
    task.checks,
    new Map([[file, { format: "sqlite", view }]]),
  );
  expect(native.map(({ passed }) => passed)).toEqual(expected);
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  // Run the actual rendered CHECKS and evaluator; only framework imports are omitted.
  const verifier = renderTaskVerifier(task, "notes")
    .split("\n")
    .filter((line) => !line.startsWith("from agentenv_protocol"))
    .join("\n");
  const script = join(root, "verify-numbers.py");
  await writeFile(
    script,
    `${imports}${PYTHON_HELPERS}\n${verifier}
entry = _sqlite(Path(sys.argv[1]))
print(json.dumps({"entry": entry, "results": evaluate(CHECKS, {"numbers.db": entry})}))
`,
  );
  const before = await readFile(path);
  const result = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", "-X", "utf8", script, path],
      { encoding: "utf8" },
    ),
  ) as { entry: { view: unknown }; results: { id: string; result: boolean }[] };
  // JSON wire conversion matches the Node view, while Python still holds the REAL as float.
  expect(result.entry.view).toEqual(view);
  expect(result.results.map(({ id, result: passed }) => [id, passed])).toEqual(
    native.map(({ id, passed }) => [id, passed]),
  );
  expect(result.results.map(({ result: passed }) => passed)).toEqual(expected);
  expect((await readFile(path)).equals(before)).toBe(true);
});
