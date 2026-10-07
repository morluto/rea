import * as t from "@babel/types";
import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyBinding, origin } from "./javascriptSemanticAnalysis.fixture.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { calleeName } from "./javascriptStaticAnalysisHelpers.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const memberChain = ".next".repeat(12_000);

it("retains native addon observations through a deep member initializer", () => {
  const analysis = analyzeJavaScriptStaticSource(
    `const value = require("./addon.node")${memberChain}.last[""];`,
  );
  expect(analysis.electron.native_addon_bindings).toEqual([
    expect.objectContaining({ specifier: "./addon.node", members: ["last"] }),
  ]);
  expect(analysis.parse_error_count).toBe(0);
});

it("keeps a deep non-native initializer outside native addon observations", () => {
  const analysis = analyzeJavaScriptStaticSource(
    `const value = root${memberChain}.last;`,
  );
  expect(analysis.electron.native_addon_bindings).toEqual([]);
  expect(analysis.parse_status).toBe("complete");
});

it("retains unknown value diagnostics and references after a deep member initializer", () => {
  const ir = analyzeJavaScriptSemantics(
    `const value = root${memberChain}.last;`,
  );
  expect(ir.coverage).toEqual({ status: "complete", omittedCount: 0 });
  expect(onlyBinding(ir, "value")).toMatchObject({
    value: { status: "unknown", reason: "Cannot project last from unknown." },
    provenance: { status: "unknown", reason: "Unbound identifier root." },
  });
  expect(ir.references.map(({ name, role }) => ({ name, role }))).toEqual([
    { name: "root", role: "read" },
  ]);
});

it.each([
  `const value = require("./dependency.js")${memberChain}[""].last;`,
  `const dependency = require("./dependency.js"); const value = dependency${memberChain}[""].last;`,
  `const value = require("./dependency.js")?.next${memberChain}[""].last;`,
])("preserves the full literal module path (case %#)", (source) => {
  const ir = analyzeJavaScriptSemantics(source);
  const path = origin(onlyBinding(ir, "value"));
  expect(path.specifier).toBe("./dependency.js");
  expect(path.importedPath).toEqual([
    ...(source.includes("?.next") ? ["next"] : []),
    ...Array.from({ length: 12_000 }, () => "next"),
    "",
    "last",
  ]);
  expect(ir.coverage.status).toBe("complete");
});

it("retains a deep CommonJS re-export path without inventing dynamic module links", () => {
  const ir = analyzeJavaScriptSemantics(`
    module.exports.result = require("./dependency.js")${memberChain}.last;
    const dynamic = require("./other.js")${memberChain}[key].last;
  `);
  expect(ir.moduleLinks).toEqual([
    expect.objectContaining({
      kind: "commonjs-export",
      specifier: "./dependency.js",
      importedName: "last",
      exportedName: "result",
    }),
  ]);
  expect(onlyBinding(ir, "dynamic").provenance).toMatchObject({
    status: "unknown",
    reason: "Dynamic provenance member.",
  });
});

it("invalidates a deep mutation while retaining unrelated literal properties", () => {
  const ir = analyzeJavaScriptSemantics(`
    const root = { untouched: "retained" };
    root${memberChain}.last = 1;
    const value = root.untouched;
  `);
  expect(onlyBinding(ir, "root").value).toEqual({
    status: "object",
    properties: [
      { name: "untouched", value: { status: "literal", value: "retained" } },
    ],
    unknownProperties: true,
    omittedProperties: null,
  });
  expect(onlyBinding(ir, "value").value).toEqual({
    status: "literal",
    value: "retained",
  });
});

it("retains the complete location and unresolved target of a deep call", () => {
  const callee = `root${memberChain}.last`;
  const ir = analyzeJavaScriptSemantics(`${callee}();`);
  expect(ir.callSites).toEqual([
    expect.objectContaining({
      kind: "call",
      resolution: "unresolved",
      calleeCallableIds: [],
      calleeLocation: {
        start: { line: 1, column: 0 },
        end: { line: 1, column: callee.length },
      },
    }),
  ]);
});

it("retains deep default values without confusing their reads with parameter bindings", () => {
  const ir = analyzeJavaScriptSemantics(
    `export function inspect(value = root${memberChain}.last) { return value; }`,
  );
  expect(ir.references.map(({ name, role }) => ({ name, role }))).toEqual([
    { name: "root", role: "read" },
    { name: "value", role: "read" },
  ]);
  expect(ir.coverage.status).toBe("complete");
});

it("keeps a shadowed require local through a deep member initializer", () => {
  const ir = analyzeJavaScriptSemantics(
    `function inspect(require) { const value = require("./dependency.js")${memberChain}.last; return value; }`,
  );
  expect(ir.moduleLinks).toEqual([]);
  expect(onlyBinding(ir, "value").provenance.origins).toEqual([]);
});

it.each([
  ["root.first.last()", "root.first.last"],
  ['root[""].last()', "root..last"],
  ['("")[""].last()', "last"],
  ['("")[""]()', ""],
  ["root[0].last()", "root.0.last"],
  ["root[key].last()", "root.[computed@5].last"],
  ["root?.first.last()", "root.first.last"],
  [`root${memberChain}.last()`, `root${memberChain}.last`],
])("preserves exact callee syntax (case %#)", (source, expected) => {
  const file = parseJavaScriptSource(source);
  const statement = file?.program.body[0];
  if (
    !t.isExpressionStatement(statement) ||
    (!t.isCallExpression(statement.expression) &&
      !t.isOptionalCallExpression(statement.expression))
  )
    throw new Error("Expected parsed call expression");
  expect(calleeName(statement.expression.callee)).toBe(expected);
});
