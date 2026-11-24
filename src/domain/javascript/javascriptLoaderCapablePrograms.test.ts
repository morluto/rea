import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";

const requireReferences = (
  source: string,
  precision?: Parameters<typeof analyzeJavaScriptStaticSource>[1],
) =>
  analyzeJavaScriptStaticSource(source, precision)
    .references.filter(({ kind }) => kind === "require")
    .map(({ expression, specifier }) => ({ expression, specifier }));

// More alias alternatives than one alias_selections unit admits, so the
// loader walks exhaust their budget on the callee of `pick.read(input)`.
const exhaustingCall = `export function run(input, table) {
  let pick = table.first;
  ${Array.from(
    { length: 12 },
    (_, index) =>
      `if (input === ${String(index)}) pick = pick.next${String(index % 3)};`,
  ).join(" ")}
  return pick.read(input);
}`;
const tightPrecision = { alias_selections: 1 };

describe("a program that names no CommonJS loader", () => {
  it("reports no loader call when a walk only exhausted its budget", () => {
    expect(requireReferences(exhaustingCall, tightPrecision)).toEqual([]);
  });

  it.each([
    ["typeof process", `export const node = typeof process == "object";`],
    ["a static member of process", `process.emit("warning");`],
    ["process as a property name", `export const o = { process: 1 };`],
    ["the string module", "export const script = { type: `module` };"],
  ])("is not made loader-capable by %s", (_name, mention) => {
    expect(
      requireReferences(`${exhaustingCall}\n${mention}`, tightPrecision),
    ).toEqual([]);
  });
});

describe("a program that names a CommonJS loader", () => {
  it.each([
    ["an identifier named require", `export const cjs = typeof require;`],
    ["an identifier named module", `export const cjs = typeof module;`],
    ["a mainModule member", `export const main = (p) => p.mainModule;`],
    ["a computed require key", `export const load = (o) => o["require"];`],
    ["process used as a value", `export const p = process;`],
    ["a dynamic member of process", `export const at = (k) => process[k];`],
    ["an import of the module builtin", `import * as m from "node:module";`],
    ["global code", `export const g = new Function("return this")();`],
  ])("keeps an exhausted walk's unknown loader for %s", (_name, mention) => {
    expect(
      requireReferences(`${exhaustingCall}\n${mention}`, tightPrecision),
    ).toContainEqual({ expression: "pick.read(input)", specifier: null });
  });

  it.each([
    ["a free require", `const v = require("fs");`, "fs"],
    ["an alias of require", `const r = require; const v = r("fs");`, "fs"],
    ["module.require", `const v = module.require("fs");`, null],
    [
      "process.mainModule.require",
      `const v = process.mainModule.require("fs");`,
      null,
    ],
    [
      "a mainModule member of a parameter",
      `export const run = (p) => p.mainModule.require("fs");`,
      null,
    ],
    [
      "a dynamic member of process",
      `export const run = (k) => process[k].require("fs");`,
      null,
    ],
    [
      "an alias of process",
      `const p = process; const v = p.mainModule.require("fs");`,
      null,
    ],
    [
      "createRequire",
      `import { createRequire } from "node:module"; const r = createRequire(import.meta.url); export const v = r("fs");`,
      "fs",
    ],
  ])("still reports %s", (_name, source, specifier) => {
    expect(requireReferences(source).map((r) => r.specifier)).toEqual([
      specifier,
    ]);
  });

  it.each([
    ["a parameter", `export const run = (r) => r("fs");`],
    ["an import", `import r from "./x.js"; export const v = r("fs");`],
    ["a member of a parameter", `export const run = (o) => o.load("fs");`],
  ])("does not report a call through %s", (_name, source) => {
    expect(requireReferences(source)).toEqual([]);
  });
});
