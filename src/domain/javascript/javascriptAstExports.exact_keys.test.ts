import { parse } from "@babel/parser";
import { expect, it } from "vitest";

import { collectJavaScriptExports } from "./javascriptAstFingerprint.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each([
  "exports[key] = 1;",
  "module[key].value = 1;",
  'module["exports.value"] = 1;',
  "module.exports = { [key]: 1 };",
  'Object[method](exports, "value", {});',
])("does not invent an export name for %s", (source) => {
  expect(collectJavaScriptExports(parse(source)).values).toEqual([]);
});

it.each([
  'exports[""] = 1;',
  'module.exports = { "": 1 };',
  'Object.defineProperty(exports, "", {});',
])("preserves the exact empty export name for %s", (source) => {
  expect(collectJavaScriptExports(parse(source)).values).toEqual([""]);
});

it("retains static computed and ordinary names", () => {
  expect(
    collectJavaScriptExports(
      parse('module["exports"]["ready"] = 1; exports.done = 2;'),
    ).values,
  ).toEqual(["done", "ready"]);
});

it("does not expose invented names in bundler module analysis", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    globalThis.webpackChunkApp.push([[1], { 1: function(module, exports) {
      exports[key] = 1;
      module["exports.value"] = 2;
      module.exports = { [key]: 3, ready: 4 };
    } }]);
  `);
  expect(analysis.parse_status).toBe("complete");
  expect(analysis.bundler_registrations[0]?.modules[0]?.exports).toEqual([
    "ready",
  ]);
});
