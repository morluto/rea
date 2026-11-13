import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { inspectPythonPycInputSchema } from "../domain/python/pythonPyc.js";
import {
  PYTHON_PYC_EQUALITY_MAGIC,
  pythonPycEqualityCases,
} from "../../tests/fixtures/pythonPycCodeEquality.js";
import { parsePythonPyc } from "./PythonPycParser.js";

const defaults = inspectPythonPycInputSchema.parse({
  path: "/artifacts/equality.pyc",
});

// CPython 3.12 marshals two code objects into one frozenset constant. Its
// marshal.loads result is the oracle: code equality ignores co_qualname,
// co_filename and co_stacksize, but not the name, first line, line and
// exception tables, or type-sensitive constants.
it.each(pythonPycEqualityCases)(
  "matches CPython frozenset identity when $differs differs",
  (fixture) => {
    const bytes = Buffer.from(fixture.hex, "hex");
    const report = parsePythonPyc(
      bytes,
      {
        path: defaults.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      defaults,
    );
    expect(report.header).toMatchObject({
      magic: PYTHON_PYC_EQUALITY_MAGIC,
      python_version: "3.12",
      code_layout: "py311",
    });
    const [module, ...members] = report.code_objects;
    expect(module?.consts.at(-1)).toEqual({
      kind: "frozenset",
      length: fixture.frozensetLength,
    });
    // Only the members CPython keeps reach the report as code objects.
    expect(module?.nested_code).toHaveLength(fixture.frozensetLength);
    expect(members).toHaveLength(fixture.frozensetLength);
    if (fixture.kept !== null) expect(members[0]).toMatchObject(fixture.kept);
  },
);

it("covers both CPython equality outcomes", () => {
  const outcomes = pythonPycEqualityCases.map((fixture) => [
    fixture.cpythonEqual,
    fixture.frozensetLength,
  ]);
  expect(outcomes).toContainEqual([true, 1]);
  expect(outcomes).toContainEqual([false, 2]);
  for (const [equal, length] of outcomes) expect(length).toBe(equal ? 1 : 2);
});
