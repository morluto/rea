import * as t from "@babel/types";
import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";

import {
  collectJavaScriptExports,
  fingerprintJavaScriptAst,
} from "./javascriptAstFingerprint.js";
import { javascriptBundlerFactoryRoles } from "./javascriptBundlerFactoryRoles.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const memberChain = ".next".repeat(12_000);
const ordinaryMemberChain = ".next".repeat(64);

it("retains the root export and fingerprints the value of a 12,000-member assignment", () => {
  const file = parseJavaScriptSource(
    `function factory(module, exports) { exports${memberChain}.last = 1; }`,
  );
  const factory = file?.program.body[0];
  if (file === null || !t.isFunctionDeclaration(factory))
    throw new Error("Expected a parsed factory");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(file.program),
  );
  expect(
    collectJavaScriptExports(factory, {
      roles: javascriptBundlerFactoryRoles(factory, "webpackChunkDeep"),
      index,
    }),
  ).toEqual({ values: ["next"], unknown: 0 });
  const statement = factory.body.body[0];
  if (
    !t.isExpressionStatement(statement) ||
    !t.isAssignmentExpression(statement.expression)
  )
    throw new Error("Expected a factory assignment");
  const before = fingerprintJavaScriptAst(factory);
  statement.expression.right = t.numericLiteral(2);
  expect(fingerprintJavaScriptAst(factory)).not.toBe(before);
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

it("recognizes a bundler runtime through nested member names", () => {
  const source = `globalThis.webpackChunkApp${ordinaryMemberChain}.push([[1], { 1: function(module) { module.exports.ok = 42; } }]);`;
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

it.each(["1 as const", "1 satisfies number"])(
  "keeps numeric bundle identities through erased syntax: %s",
  (entry) => {
    const analysis = analyzeJavaScriptStaticSource(`
      globalThis.webpackChunkApp.push([[(${entry})], {
        1: function(module, exports, req) { req((2 as const)); req.e((3 satisfies number)); },
        2: function() {}
      }, function(req) { req((${entry})); }]);
    `);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.bundler_registrations).toMatchObject([
      {
        chunk_keys: ["1"],
        unknown_chunk_keys: 0,
        entry_module_keys: ["1"],
        unknown_entry_module_keys: 0,
        async_chunk_keys: ["3"],
        unknown_async_chunk_keys: 0,
      },
    ]);
    expect(analysis.references).toContainEqual(
      expect.objectContaining({
        specifier: "2",
        loader: "factory-loader",
        module_key: "1",
      }),
    );
  },
);

it.each(["0, {}", "[], modules"])(
  "does not grant factory-loader authority to a rejected registration: %s",
  (entry) => {
    const analysis = analyzeJavaScriptStaticSource(`
      globalThis.webpackChunkApp.push([${entry}, function(req) { req("electron"); }]);
    `);
    expect(analysis.bundler_registrations).toEqual([]);
    expect(analysis.references).toEqual([]);
  },
);
