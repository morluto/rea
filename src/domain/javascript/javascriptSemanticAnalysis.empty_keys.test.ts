import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { topLevelBinding } from "./javascriptSemanticAnalysis.fixture.js";

it("resolves void keys while retaining their calls and binding writes", () => {
  const ir = analyzeJavaScriptSemantics(`
    import {spawn} from "node:child_process";
    const routes = {[void sideEffect()]: "HOME"};
    const root = routes[void 0];
    let argv=[]; const changed = {[void (argv={})]: 1};
    spawn("changed",argv,{stdio:"inherit"});
  `);
  expect(ir.bindings.find(({ name }) => name === "root")?.value).toEqual({
    status: "literal",
    value: "HOME",
  });
  expect(ir.references.some(({ name }) => name === "sideEffect")).toBe(true);
  expect(ir.childProcessSpawns[0]?.stdioMode).toBe("dynamic");
});

it("resolves literal empty keys while leaving computed identifiers unresolved", () => {
  const ir = analyzeJavaScriptSemantics(
    [
      "const routes = {['']: 'HOME'};",
      "const member = routes[''];",
      "const {['']: pattern} = routes;",
      "const unknown = routes[key];",
    ].join("\n"),
  );
  for (const name of ["member", "pattern"])
    expect(topLevelBinding(ir, name).value).toEqual({
      status: "literal",
      value: "HOME",
    });
  expect(topLevelBinding(ir, "unknown").value.status).toBe("unknown");
  expect(ir.frontiers).toMatchObject([
    {
      kind: "dynamic-property",
      location: {
        start: { line: 4, column: 23 },
        end: { line: 4, column: 26 },
      },
    },
  ]);
});

it("retains exact empty method names and environment keys", () => {
  const ir = analyzeJavaScriptSemantics(`
    const target = { ['']() { return 42; } };
    class Holder { ""() { return 2; } }
    const empty = process.env[''];
    const dynamic = process.env[key];
  `);
  expect(
    ir.callables
      .filter(({ kind }) => kind === "method")
      .map(({ name }) => name),
  ).toEqual(["", ""]);
  expect(
    ir.configurationOperations.map(({ kind, key, resolution }) => ({
      kind,
      key,
      resolution,
    })),
  ).toEqual([
    { kind: "environment", key: "", resolution: "complete" },
    { kind: "environment", key: null, resolution: "partial" },
  ]);
});

it("retains exact empty require paths and dependencies without dynamic-key bindings", () => {
  const ir = analyzeJavaScriptSemantics(`
    const { '': fromPattern } = require("./table.js");
    const fromMember = require("./table.js")[''];
    const { [key]: dynamicPattern } = require("./table.js");
    const dynamicMember = require("./table.js")[key];
    module.exports.root = require("./table.js")[''];
  `);
  expect(
    ir.moduleLinks.map(
      ({ kind, specifier, importedName, localName, exportedName }) => [
        kind,
        specifier,
        importedName,
        localName,
        exportedName,
      ],
    ),
  ).toEqual([
    ["require", "./table.js", "", "fromPattern", null],
    ["require", "./table.js", "", "fromMember", null],
    ["require", "./table.js", null, null, null],
    ["require", "./table.js", null, null, null],
    ["commonjs-export", "./table.js", "", null, "root"],
  ]);
  for (const name of ["dynamicPattern", "dynamicMember"])
    expect(topLevelBinding(ir, name).provenance).toMatchObject({
      status: "unknown",
      origins: [],
    });
});

it("retains exact empty request field names without dynamic fields", () => {
  const ir = analyzeJavaScriptSemantics(`
    fetch("https://example.test", { '': value, [key]: 1, body: "x" });
  `);
  expect(
    ir.requestOperations.flatMap(({ fields }) =>
      fields.map(({ name }) => name),
    ),
  ).toEqual(["", "body"]);
});

it("retains the exact empty CommonJS export name", () => {
  const ir = analyzeJavaScriptSemantics(`
    exports[''] = 1;
    module.exports[''] = 2;
    exports['ok'] = 3;
    exports[key] = 4;
  `);
  expect(ir.moduleLinks.map(({ exportedName }) => exportedName)).toEqual([
    "",
    "",
    "ok",
    "*",
  ]);
});
