import { expect, it } from "vitest";

import { collectJavaScriptExports } from "./javascriptAstFingerprint.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const memberChain = ".next".repeat(12_000);

it("collects a 12,000-member CommonJS export path without recursion", () => {
  const file = parseJavaScriptSource(`exports${memberChain}.last = 1;`);
  if (file === null) throw new Error("Expected valid JavaScript");
  expect(collectJavaScriptExports(file).values).toEqual([
    `${"next.".repeat(12_000)}last`,
  ]);
});

it("preserves empty, dynamic, this, and private member path behavior", () => {
  const file = parseJavaScriptSource(`
    exports[""].value = 1;
    exports[""] = 0;
    exports[key].value = 2;
    this.exports.ignored = 3;
    class Example { #private = 0; read() { this.#private = 1; } }
  `);
  if (file === null) throw new Error("Expected valid JavaScript");
  expect(collectJavaScriptExports(file).values).toEqual([
    "",
    ".value",
    "key.value",
  ]);
});

it("keeps left-first and outer-member-first bundler runtime matches", () => {
  const source = `
    (globalThis.webpackChunkLeft || globalThis.webpackChunkRight).push([[1], { 1: function() {} }]);
    globalThis.webpackChunkOuter.webpackChunkInner.push([[2], { 2: function() {} }]);
  `;
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(
    analysis.bundler_registrations.find(({ chunk_keys }) =>
      chunk_keys.includes("1"),
    )?.runtime,
  ).toBe("webpackChunkLeft");
  expect(
    analysis.bundler_registrations.find(({ chunk_keys }) =>
      chunk_keys.includes("2"),
    )?.runtime,
  ).toBe("webpackChunkInner");
});

it("analyzes a 12,000-member bundler runtime chain without recursion", () => {
  const source = `globalThis.webpackChunkApp${memberChain}.push([[1], { 1: function(module) { module.exports.ok = 42; } }]);`;
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_status).toBe("complete");
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.bundler_registrations).toHaveLength(1);
  expect(analysis.bundler_registrations[0]).toMatchObject({
    bundler: "webpack",
    runtime: "webpackChunkApp",
    chunk_keys: ["1"],
    modules: [expect.objectContaining({ exports: ["ok"] })],
  });
});
