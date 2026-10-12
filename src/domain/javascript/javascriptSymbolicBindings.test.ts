import { expect, it } from "vitest";
import * as t from "@babel/types";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { JavaScriptSymbolicBindings } from "./javascriptSymbolicBindings.js";
import {
  symbolicTruth,
  symbolicVariants,
  type SymbolicValue,
} from "./javascriptSymbolicValues.js";

const resolverFor = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("symbolic source fixture did not parse");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  return {
    parsed,
    resolver: new JavaScriptSymbolicBindings(state, parsed.program),
  };
};

/** Parse a fixture and collect the first argument of each inspect call. */
const inspectFixture = (
  source: string,
  evaluate: (
    resolver: JavaScriptSymbolicBindings,
    node: t.CallExpression,
  ) => SymbolicValue = (resolver, node) => resolver.evaluate(node.arguments[0]),
) => {
  const { parsed, resolver } = resolverFor(source);
  const values: SymbolicValue[] = [];
  traverseJavaScriptAst(parsed.program, {
    enter: (node) => {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "inspect" })
      ) {
        values.push(evaluate(resolver, node));
      }
    },
  });
  return { parsed, resolver, values };
};

const inspectedValues = (source: string): SymbolicValue[] =>
  inspectFixture(source).values;

const inspectOne = (source: string): SymbolicValue => {
  const values = inspectedValues(source);
  expect(values).toHaveLength(1);
  const value = values[0];
  if (value === undefined) throw new Error("inspect call result missing");
  return value;
};

it("substitutes numeric modules, named exports and captured wrapper arguments", () => {
  const { resolver, values } = inspectFixture(`(() => {
    const modules = {
      4(module) { module.exports = require("electron"); },
      8(module, exports, load) {
        const electron = load(4);
        exports.sender = function(channel) { return (...args) => electron.ipcRenderer.send(channel,...args); };
      },
      12(module, exports, load) { const helpers = load(8); const api = {copy: helpers.sender("test:copy")}; inspect(api.copy); }
    };
    function load(id) { const m = {exports:{}}; modules[id](m,m.exports,load); return m.exports; }
    load(12);
  })();`);
  expect(values).toHaveLength(1);
  const value = values[0];
  if (value === undefined) throw new Error("inspect call result missing");
  const fn = symbolicVariants(value).find((v) => v.kind === "function");
  expect(fn?.kind).toBe("function");
  if (fn?.kind !== "function" || !t.isCallExpression(fn.node.body))
    throw new Error("closure missing");
  const env = resolver.bind(fn, []);
  expect(resolver.evaluate(fn.node.body.callee, env)).toEqual({
    kind: "external",
    path: ["electron", "ipcRenderer", "send"],
  });
  expect(resolver.arguments(fn.node.body, env)[0]).toEqual({
    kind: "literal",
    value: "test:copy",
  });
});

it("checks block lexical initializers against their containing function call", () => {
  const { parsed, resolver } = resolverFor(`run();
    function run() { { const value = require("electron"); inspect(value); } }`);
  let resolved: SymbolicValue | undefined;
  traverseJavaScriptAst(parsed.program, {
    enter: (node) => {
      if (
        !t.isCallExpression(node) ||
        !t.isIdentifier(node.callee, { name: "inspect" })
      )
        return;
      const fn = parsed.program.body.find(
        (statement): statement is t.FunctionDeclaration =>
          t.isFunctionDeclaration(statement) && statement.id?.name === "run",
      );
      if (!fn) throw new Error("run declaration missing");
      const call = parsed.program.body[0];
      if (
        !t.isExpressionStatement(call) ||
        !t.isCallExpression(call.expression)
      )
        throw new Error("run invocation missing");
      resolved = resolver.evaluate(
        node.arguments[0],
        resolver.bind(
          {
            kind: "function",
            node: fn,
            environment: { values: new Map() },
            origins: [],
          },
          [],
          call.expression,
        ),
      );
    },
  });
  expect(resolved).toEqual({ kind: "external", path: ["electron"] });
});

it("keeps same-factory reads before initialization unresolved", () => {
  const { values, resolver } = inspectFixture(
    `(() => {
    const modules = { 9(module) { inspect(value); const value = require("electron"); } };
    function load(id) { const m={exports:{}}; modules[id](m); return m.exports; }
    load(9);
  })();`,
    (bindings, node) =>
      bindings.evaluate(node.arguments[0], bindings.environmentAt(node)),
  );
  expect(values).toHaveLength(1);
  const resolved = values[0];
  if (resolved === undefined) throw new Error("inspect call result missing");
  expect(resolved).toEqual({
    kind: "unknown",
    reason: "initializer not available at this read",
  });
  expect(resolver.unresolved).toBe(true);
});

it("invalidates a bootstrap module slot mutated through an alias", () => {
  const values = inspectedValues(`(() => {
    const modules = {
      1(module) { module.exports = require("electron"); },
      2(module, exports, load) { inspect(load(1)); inspect(load(3)); },
      3(module) { module.exports = require("electron"); }
    };
    const table = modules;
    function load(id) { const m = {exports:{}}; modules[id](m,m.exports,load); return m.exports; }
    table[1] = function(module) { module.exports = require("other"); };
    delete table[3];
    load(2);
  })();`);
  expect(values).toHaveLength(2);
  expect(values).toEqual([
    expect.objectContaining({ kind: "unknown" }),
    expect.objectContaining({ kind: "unknown" }),
  ]);
});

it.each([
  `const electron=require("electron"); const ipc=electron.ipcMain; ipc.handle=()=>null; inspect(electron.ipcMain.handle);`,
  `require("electron").ipcMain.handle=()=>null; inspect(require("electron").ipcMain.handle);`,
  `const electron=require("electron"); ({ipcMain:electron.ipcMain}=replacement); inspect(electron.ipcMain);`,
  `const electron=require("electron"); for(electron.ipcMain of replacements){} inspect(electron.ipcMain);`,
])("invalidates visibly overwritten Electron members: %s", (source) => {
  const values = inspectedValues(source);
  expect(values).toHaveLength(1);
  expect(values[0]?.kind).toBe("unknown");
});

it("does not substitute a lexical or var initializer before its source write", () => {
  for (const source of [
    `inspect(value); const value = require("electron");`,
    `function run() { inspect(value); var value = require("electron"); }`,
  ]) {
    const values = inspectedValues(source);
    expect(values).toHaveLength(1);
    const value = values[0];
    if (value === undefined) throw new Error("inspect call result missing");
    expect(value).toMatchObject({ kind: "unknown" });
  }
});

it("keeps function declarations hoisted and checks closures at invocation", () => {
  const inspected = inspectedValues(`
    inspect(read);
    function read() { return value; }
    function localRead() {
      const local = require("electron");
      return local;
    }
    const closure = () => value;
    const value = require("electron");
    inspect(closure());
    inspect(localRead());
  `);
  expect(inspected[0]).toMatchObject({ kind: "function" });
  expect(inspected[1]).toEqual({ kind: "external", path: ["electron"] });
  expect(inspected[2]).toEqual({ kind: "external", path: ["electron"] });
});

it("keeps a synchronous cross-function callback before initialization unresolved", () => {
  const { parsed, resolver } = resolverFor(`function outer() {
      const value = require("electron");
      return use(() => value);
    }
    function use(callback) { return callback(); }
    inspect(outer());`);
  const outer = parsed.program.body.find(
    (statement): statement is t.FunctionDeclaration =>
      t.isFunctionDeclaration(statement) && statement.id?.name === "outer",
  );
  const outerCall = parsed.program.body.find(
    (statement): statement is t.ExpressionStatement =>
      t.isExpressionStatement(statement) &&
      t.isCallExpression(statement.expression) &&
      t.isIdentifier(statement.expression.callee, { name: "inspect" }),
  );
  if (!outer || !outerCall || !t.isCallExpression(outerCall.expression))
    throw new Error("outer fixture missing");
  const invocation = outer.body.body.find(
    (statement): statement is t.ReturnStatement =>
      t.isReturnStatement(statement),
  );
  if (!invocation || !t.isCallExpression(invocation.argument))
    throw new Error("synchronous callback call missing");
  const result = resolver.evaluate(
    invocation.argument,
    resolver.bind(
      {
        kind: "function",
        node: outer,
        environment: { values: new Map() },
        origins: [],
      },
      [],
      outerCall.expression,
    ),
  );
  expect(result).toMatchObject({ kind: "unknown" });
});

it("uses completed activation provenance for a returned closure", () => {
  const result = inspectOne(`inspect(use(outer()));
    function use(callback) { return callback(); }
    function outer() {
      const value = require("electron");
      return () => value;
    }`);
  expect(result).toEqual({ kind: "external", path: ["electron"] });
});

it("does not treat statements after a returned closure as initialized", () => {
  const result = inspectOne(`inspect(outer()());
    function outer() {
      return () => value;
      const value = require("electron");
    }`);
  expect(result).toMatchObject({ kind: "unknown" });
});

it("does not treat statements after a returned module factory as initialized", () => {
  const result = inspectOne(`(() => {
    const modules = {
      5(module, exports) {
        exports.read = () => electron;
        return;
        const electron = require("electron");
      },
      9(module, exports, load) { const helper = load(5); inspect(helper.read()); }
    };
    function load(id) { const m={exports:{}}; modules[id](m,m.exports,load); return m.exports; }
    load(9);
  })();`);
  expect(result).toMatchObject({ kind: "unknown" });
});

it("treats known symbolic records and loaders as truthy", () => {
  expect(symbolicTruth({ kind: "record", values: new Map() })).toBe(true);
  expect(symbolicTruth({ kind: "loader", modules: new Map() })).toBe(true);
  expect(
    symbolicTruth({
      kind: "union",
      values: [
        { kind: "record", values: new Map() },
        { kind: "loader", modules: new Map() },
      ],
    }),
  ).toBe(true);
});

it("retains branch predicates on conditionally selected wrapper functions", () => {
  const value = inspectOne(`
    const selected = enabled
      ? () => navigator.clipboard.writeText("yes")
      : () => navigator.clipboard.writeText("no");
    inspect(selected);
  `);
  const functions = symbolicVariants(value).filter(
    (candidate) => candidate.kind === "function",
  );
  expect(functions).toHaveLength(2);
  expect(functions.map((fn) => fn.conditions?.[0]?.positive)).toEqual([
    true,
    false,
  ]);
});

it("retains fallthrough return guards after a one-sided early return", () => {
  const value = inspectOne(`
    function choose() {
      if (enabled) return () => navigator.clipboard.writeText("early");
      return () => navigator.clipboard.writeText("late");
    }
    inspect(choose());
  `);
  const functions = symbolicVariants(value).filter(
    (candidate) => candidate.kind === "function",
  );
  expect(functions).toHaveLength(2);
  expect(functions[0]).toMatchObject({ conditions: [{ positive: true }] });
  expect(functions[1]).toMatchObject({ conditions: [{ positive: false }] });
});

it("composes fallthrough guards across successive conditional returns", () => {
  const value = inspectOne(`
    function choose() {
      if (first) return () => navigator.clipboard.writeText("first");
      if (second) return () => navigator.clipboard.writeText("second");
      return () => navigator.clipboard.writeText("last");
    }
    inspect(choose());
  `);
  const functions = symbolicVariants(value).filter(
    (candidate) => candidate.kind === "function",
  );
  expect(functions).toHaveLength(3);
  expect(functions[0]?.conditions?.map(({ positive }) => positive)).toEqual([
    true,
  ]);
  expect(functions[1]?.conditions?.map(({ positive }) => positive)).toEqual([
    false,
    true,
  ]);
  expect(functions[2]?.conditions?.map(({ positive }) => positive)).toEqual([
    false,
    false,
  ]);
});

it("marks return guards unresolved when a nested join cannot be represented", () => {
  const value = inspectOne(`
    function choose() {
      if (enabled) {
        if (other) return () => navigator.clipboard.writeText("early");
      }
      return () => navigator.clipboard.writeText("late");
    }
    inspect(choose());
  `);
  const functions = symbolicVariants(value).filter(
    (candidate) => candidate.kind === "function",
  );
  expect(functions).toHaveLength(2);
  expect(functions[1]).toMatchObject({ conditionUnresolved: true });
});

it.each([
  [
    "duplicate literal keys use the last value",
    `const object = { value: "first", value: "last" }; inspect(object.value);`,
    { kind: "literal", value: "last" },
  ],
  [
    "a final accessor is unknown",
    `const object = { value: "first", get value() { return "accessor"; } }; inspect(object.value);`,
    { kind: "unknown", reason: "accessor property" },
  ],
  [
    "a later literal overwrites an accessor",
    `const object = { get value() { return "accessor"; }, value: "last" }; inspect(object.value);`,
    { kind: "literal", value: "last" },
  ],
  [
    "a later unknown computed key can overwrite an earlier value",
    `const object = { value: "known", [dynamic]: "other" }; inspect(object.value);`,
    { kind: "unknown", reason: "dynamic property overwrite" },
  ],
  [
    "a later static key overrides an earlier unknown computed key",
    `const object = { [dynamic]: "other", value: "last" }; inspect(object.value);`,
    { kind: "literal", value: "last" },
  ],
  [
    "a known spread can override an earlier static value",
    `const replacement = { value: "spread" }; const object = { value: "first", ...replacement }; inspect(object.value);`,
    { kind: "literal", value: "spread" },
  ],
] as const)("resolves object properties when %s", (_case, source, expected) => {
  expect(inspectOne(source)).toEqual(expected);
});

it("propagates branch guards through object properties and function calls", () => {
  const inspected = inspectedValues(`
    const direct = flag
      ? { action: () => navigator.clipboard.writeText("direct-yes") }
      : { action: () => navigator.clipboard.writeText("direct-no") };
    function choose() {
      return flag
        ? () => navigator.clipboard.writeText("call-yes")
        : () => navigator.clipboard.writeText("call-no");
    }
    const called = { action: choose() };
    inspect(direct.action);
    inspect(called.action);
  `);
  for (const value of inspected) {
    const functions = symbolicVariants(value).filter(
      (candidate) => candidate.kind === "function",
    );
    expect(functions).toHaveLength(2);
    expect(functions.map((fn) => fn.conditions?.[0]?.positive)).toEqual([
      true,
      false,
    ]);
  }
});
