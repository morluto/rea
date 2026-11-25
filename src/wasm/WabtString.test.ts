import { expect, it } from "vitest";
import { parseWabtWat } from "./WabtWat.js";

it("frames escaped quotes and trailing backslashes without consuming the next form", () => {
  const longRun = "\\".repeat(5);
  const names = [
    "",
    'a"b\\',
    '\\"tail',
    "\\\\",
    '\\\\"tail',
    longRun,
    longRun + '"tail',
  ];
  const imports = names.map(
    (name) => `(import "env" ${JSON.stringify(name)} (func))`,
  );
  const exported = String.raw`(export "fake\22Export[1]:" (func 0))`;
  const report = parseWabtWat(`(module ${imports.join(" ")} ${exported})`);
  expect(report.imports).toEqual(imports);
  expect(report.exports).toEqual([exported]);
  expect(report.interface.entries.map(({ name }) => name)).toEqual([
    ...names,
    'fake"Export[1]:',
  ]);
});

it("rejects missing terminators, including a dangling escape or escaped last quote", () => {
  for (const source of ['"', '"payload', '"payload\\', '"payload\\"']) {
    expect(() => parseWabtWat(`(module (import ${source}`)).toThrow(
      expect.objectContaining({
        _tag: "WabtAdmissionError",
        code: "incomplete_string",
      }),
    );
  }
});

it("treats comment and form punctuation inside quoted WAT as string data", () => {
  const result = parseWabtWat(String.raw`(module
    (; outer " (; inner ;) ;)
    (import "env" "a\"b\\(;);;\00" (func (param i32)))
    (memory 1)
    (export "memory" (memory 0))
    (data (i32.const 0) "(; );) ;; \" \\"))`);
  expect(result.interface.entries).toMatchObject([
    {
      direction: "import",
      name: 'a"b\\(;);;\0',
      signature: { kind: "func", params: ["i32"] },
    },
    {
      direction: "export",
      name: "memory",
      signature: { kind: "memory", minimum: "1" },
    },
  ]);
  expect(() => parseWabtWat('(module (import "env" "\\q" (func)))')).toThrow(
    expect.objectContaining({
      _tag: "WabtAdmissionError",
      code: "unsupported_escape",
    }),
  );
});
