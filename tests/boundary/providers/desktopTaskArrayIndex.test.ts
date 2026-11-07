import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PYTHON_TASK_EVALUATOR } from "../../../src/domain/desktop/appTaskPython.js";
import { locatePointer } from "../../../src/domain/desktop/viewPointer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("keeps oversized array indices absent without crashing exported task checks", async () => {
  const huge = "9".repeat(5000);
  const cases = [
    { items: [1], pointer: `/${huge}` },
    { items: [], pointer: `/${huge}` },
    { items: [1], pointer: "/0" },
    { items: [1], pointer: "/1" },
    { items: Array.from({ length: 12 }, (_, index) => index), pointer: "/11" },
    { items: Array.from({ length: 12 }, (_, index) => index), pointer: "/12" },
    { items: [1], pointer: "/01" },
  ];
  const folder = await createTestTempDirectory("task-array-index-");
  const script = join(folder, "fixture.py");
  await writeFile(
    script,
    `import json, re, math, sys
${PYTHON_TASK_EVALUATOR}
results = []
for case in json.load(sys.stdin):
    items, pointer = case["items"], case["pointer"]
    located = _locate(items, pointer)
    check = {"id": "absent", "kind": "value_absent", "file": "state.json", "pointer": pointer}
    verdict = evaluate([check], {"state.json": {"format": "json", "view": items, "truncated": False}})[0]
    results.append([located[0], located[1], verdict["result"]])
print(json.dumps(results))
`,
  );
  const results = JSON.parse(
    execFileSync("python3", ["-I", "-B", script], {
      input: JSON.stringify(cases),
      encoding: "utf8",
    }),
  );
  expect(results).toEqual(
    cases.map(({ items, pointer }) => {
      const located = locatePointer(items, pointer);
      return [
        located.kind,
        located.kind === "value" ? located.value : null,
        located.kind === "none",
      ];
    }),
  );
});

it("evaluates root-array member counts in the exported Python verifier", async () => {
  const folder = await createTestTempDirectory("task-root-count-");
  const script = join(folder, "fixture.py");
  await writeFile(
    script,
    `import json, re, math
${PYTHON_TASK_EVALUATOR}
check = {"id": "count", "kind": "member_count", "file": "state.json", "pointer": "", "equals": 3}
print(json.dumps([evaluate([check], {"state.json": {"format": "json", "view": values, "truncated": False}})[0]["result"] for values in [[1, 2], [1, 2, 3]]]))
`,
  );
  expect(
    JSON.parse(
      execFileSync("python3", ["-I", "-B", script], { encoding: "utf8" }),
    ),
  ).toEqual([false, true]);
});
