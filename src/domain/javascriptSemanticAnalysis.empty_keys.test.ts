import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it.each([
  "const routes = {'': 'HOME'}; const root = routes[''];",
  "const routes = {['']: 'HOME'}; const root = routes[''];",
  "const routes = {'': 'HOME'}; const {'': root} = routes;",
  "const routes = {'': 'HOME'}; const {['']: root} = routes;",
  "const routes = {home: 'HOME'}; const root = routes.home;",
])("preserves exact string keys in %s", (source) => {
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.bindings.find(({ name }) => name === "root")?.value).toEqual({
    status: "literal",
    value: "HOME",
  });
  expect(
    ir.frontiers.filter(({ kind }) => kind === "dynamic-property"),
  ).toEqual([]);
});

it("keeps a computed identifier key unresolved", () => {
  const ir = analyzeJavaScriptSemantics(
    "const routes = {'': 'HOME'}; const root = routes[key];",
  );
  expect(ir.bindings.find(({ name }) => name === "root")?.value.status).toBe(
    "unknown",
  );
  expect(ir.frontiers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "dynamic-property" }),
    ]),
  );
});
