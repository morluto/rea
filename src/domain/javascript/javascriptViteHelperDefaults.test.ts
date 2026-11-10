import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const candidates = (source: string) =>
  analyzeJavaScriptStaticSource(source)
    .references.filter(({ kind }) => kind === "vite-table-candidate")
    .map(({ specifier }) => specifier);

describe("Vite helper table initializer effects", () => {
  it("matches the runtime when a lowered table default reassigns the indexes", () => {
    const source = `
      function __vite__mapDeps(i) {
        var m = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : __vite__mapDeps;
        var d = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : (m.f || (m.f = [(i = []), "./first.js"]));
        return i.map(function (n) { return d[n]; });
      }
      __vite__mapDeps([1]);
    `;
    expect(runInNewContext(source)).toEqual([]);
    expect(candidates(source)).toEqual([null]);
  });

  it.each([
    ["(i = [])", null],
    ["(i.length = 0)", null],
    ["opaque(i)", null],
    ["(arguments[0] = [])", null],
    [`eval("i = []")`, null],
    ["unrelated()", "./first.js"],
    ["((i) => i)(0)", "./first.js"],
  ])("accounts for a lowered default containing %s", (value, expected) => {
    expect(
      candidates(`
        function __vite__mapDeps(i) {
          var m = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : __vite__mapDeps;
          var d = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : (m.f || (m.f = [${value}, "./first.js"]));
          return i.map(function (n) { return d[n]; });
        }
        __vite__mapDeps([1]);
      `),
    ).toEqual([expected]);
  });

  it.each([
    `const __vite__mapDeps = (i, m = __vite__mapDeps, d = m.f || (m.f = [(i = []), "./first.js"])) => i.map(n => d[n]);`,
    `function __vite__mapDeps(i, m, d) { if (m === undefined) m = __vite__mapDeps; if (d === undefined) d = m.f || (m.f = [(i = []), "./first.js"]); return i.map(n => d[n]); }`,
  ])("handles index writes in every admitted default form", (helper) => {
    expect(candidates(`${helper}\n__vite__mapDeps([1]);`)).toEqual([null]);
  });

  it.each([
    ["{i: 0, arguments: 1}", "./first.js"],
    ["{[i]: 0}", null],
    ["{i}", null],
    ["({value: i} = {value: []})", null],
    ["([i] = [[]])", null],
  ])(
    "distinguishes property names from parameter references in %s",
    (value, expected) => {
      const source = `
      function __vite__mapDeps(i) {
        var m = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : __vite__mapDeps;
        var d = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : (m.f || (m.f = ["./first.js", ${value}]));
        return i.map(function (n) { return d[n]; });
      }
      __vite__mapDeps([0]);
    `;
      expect(candidates(source)).toEqual([expected]);
      if (expected !== null)
        expect(runInNewContext(source)).toEqual([expected]);
    },
  );

  it.each([
    `const __vite__mapDeps = (i, m = __vite__mapDeps, d = m.f || (m.f = ["./first.js", {i: 0}])) => i.map(n => d[n]);`,
    `function __vite__mapDeps(i, m, d) { if (m === undefined) m = __vite__mapDeps; if (d === undefined) d = m.f || (m.f = ["./first.js", {i: 0}]); return i.map(n => d[n]); }`,
  ])(
    "retains unrelated property keys across helper default forms",
    (helper) => {
      const source = `${helper}\n__vite__mapDeps([0]);`;
      expect(runInNewContext(source)).toEqual(["./first.js"]);
      expect(candidates(source)).toEqual(["./first.js"]);
    },
  );
});
