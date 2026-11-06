import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { parseDesktopTask } from "../../../src/domain/desktop/appTask.js";
import { sameJson } from "../../../src/domain/desktop/appTaskChecks.js";
import {
  PYTHON_TASK_EVALUATOR,
  renderTaskVerifier,
} from "../../../src/domain/desktop/appTaskPython.js";
import { jsonView } from "../../../src/domain/desktop/stateFormats.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const PYTHON = process.platform === "win32" ? "python" : "python3";

const nested = (
  depth: number,
  leaf: JsonValue,
  shape = "object",
): JsonValue => {
  let value = leaf;
  for (let level = 0; level < depth; level += 1)
    value =
      shape === "array" || (shape === "mixed" && level % 2 === 0)
        ? [value]
        : { child: value };
  return value;
};

/** Compile and execute the exact emitted evaluator; only unavailable protocol imports are omitted. */
const DRIVER = `import ast, json, sys
source = ast.parse(open(sys.argv[1], encoding="utf-8").read())
source.body = [node for node in source.body if not isinstance(node, ast.ImportFrom)]
module = {}
exec(compile(source, sys.argv[1], "exec"), module)
seed, final = json.load(sys.stdin)
print(json.dumps([module["CHECKS"], module["evaluate"](module["CHECKS"], seed),
                  module["evaluate"](module["CHECKS"], final)]))
`;

it.each(["object", "array", "mixed"])(
  "exports and grades a %s value at the JSON view's depth boundary",
  async (shape) => {
    const value = nested(499, 1, shape);
    const final = { payload: value };
    const seed = { payload: nested(499, 0, shape) };
    expect(jsonView(JSON.stringify(final)).ok).toBe(true);
    const task = parseDesktopTask(
      {
        name: "nested-value",
        prompt: "Change the nested value.",
        checks: [
          {
            id: "nested",
            kind: "value_equals",
            file: "state.json",
            pointer: "/payload",
            value,
          },
        ],
      },
      () => true,
    );
    expect(task.ok).toBe(true);
    if (!task.ok) throw new Error(task.error);
    const root = await createTestTempDirectory("task-json-depth-");
    const verifier = join(root, "verify.py");
    await writeFile(verifier, renderTaskVerifier(task.value, "notes"), "utf8");
    const result = JSON.parse(
      execFileSync(PYTHON, ["-I", "-B", "-X", "utf8", "-c", DRIVER, verifier], {
        encoding: "utf8",
        input: JSON.stringify(
          [seed, final].map((view) => ({
            "state.json": { format: "json", view },
          })),
        ),
      }),
    ) as [unknown, { result: boolean }[], { result: boolean }[]];
    expect(result[0]).toEqual(task.value.checks);
    expect(result[1].map((check) => check.result)).toEqual([false]);
    expect(result[2].map((check) => check.result)).toEqual([true]);
  },
);

it("compares deep JSON without losing scalar types, key identity or array order", async () => {
  const cases: [JsonValue, JsonValue][] = [
    [1, 1.0],
    [true, 1],
    [0, false],
    [null, "null"],
    [
      { first: 1, second: 2 },
      { second: 2, first: 1 },
    ],
    [{ key: 1 }, { other: 1 }],
    [
      [1, 2],
      [2, 1],
    ],
    [[1], [1, 2]],
    [{}, []],
    [[], {}],
    ['café "\\\n\u0000😀', 'café "\\\n\u0000😀'],
    ["null", null],
  ];
  const pairs = cases.map(([actual, expected]) => [
    nested(400, actual, "mixed"),
    nested(400, expected, "mixed"),
  ]);
  const root = await createTestTempDirectory("task-json-equality-");
  const script = join(root, "compare.py");
  await writeFile(
    script,
    `import json, math, re, sys
${PYTHON_TASK_EVALUATOR}
print(json.dumps([_same(actual, expected) for actual, expected in json.load(sys.stdin)]))
`,
    "utf8",
  );
  const results = JSON.parse(
    execFileSync(PYTHON, ["-I", "-B", "-X", "utf8", script], {
      input: JSON.stringify(pairs),
      encoding: "utf8",
    }),
  );
  expect(results).toEqual(
    cases.map(([actual, expected]) => sameJson(actual, expected)),
  );
  expect(results).toEqual([
    true,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
    true,
    false,
  ]);
});
