import { expect, it } from "vitest";

import { JavaScriptModuleRangeIndex } from "./javascriptStaticAnalysisFindings.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each(["direct", "call"])(
  "recovers standalone module factories dispatched with %s",
  (style) => {
    const dispatch =
      style === "call"
        ? "modules[id].call(module.exports, module, module.exports, load)"
        : "modules[id](module, module.exports, load)";
    const source = `(() => {
    const modules = {
      17(module, exports, req) { exports.read = req(23); },
      23(module) { module.exports = require("electron"); }
    };
    const cache = {};
    function load(id) {
      if (cache[id]) return cache[id].exports;
      const module = cache[id] = { exports: {} };
      ${dispatch};
      return module.exports;
    }
    load(17);
  })();`;
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.bundler_registrations).toMatchObject([
      {
        bundler: "webpack",
        entry_module_keys: ["17"],
        modules: [{ module_key: "17" }, { module_key: "23" }],
      },
    ]);
    expect(analysis.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ specifier: "23", module_key: "17" }),
        expect.objectContaining({ specifier: "electron", module_key: "23" }),
      ]),
    );
  },
);

it("does not infer a bootstrap from a function table without a matching loader", () => {
  const analysis = analyzeJavaScriptStaticSource(`(() => {
    const handlers = { 17(module) { module.exports = require("electron"); } };
    function load(id) { return handlers[id](userInput); }
    load(17);
  })();`);
  expect(analysis.bundler_registrations).toEqual([]);
});

it("does not treat a same-named shadow as the factory exports parameter", () => {
  const analysis =
    analyzeJavaScriptStaticSource(`globalThis.webpackChunkApp.push([[1], {
    first(module, e, require) {
      { const e = {}; require.d(e, { shadowed: () => 1 }); e.other = 2; }
    }
  }]);`);
  expect(analysis.bundler_registrations[0]?.modules).toMatchObject([
    { module_key: "first", exports: [] },
  ]);
});

it("does not confuse a shadowed dispatch table with the outer module table", () => {
  const analysis = analyzeJavaScriptStaticSource(`(() => {
    const modules = { 17(module) { module.exports = require("electron"); } };
    function load(id) {
      const modules = userInput;
      const module = { exports: {} };
      modules[id](module, module.exports, load);
      return module.exports;
    }
    load(17);
  })();`);
  expect(analysis.bundler_registrations).toEqual([]);
});

it("retains a stable var module table without treating declaration mutability as a write", () => {
  const analysis = analyzeJavaScriptStaticSource(`(() => {
    var modules = { 17(module) { module.exports = require("electron"); } };
    function load(id) {
      const module = { exports: {} };
      modules[id](module, module.exports, load);
      return module.exports;
    }
    load(17);
  })();`);
  expect(analysis.bundler_registrations).toMatchObject([
    { entry_module_keys: ["17"], modules: [{ module_key: "17" }] },
  ]);
});

it("only attributes bootstrap entries to the recovered loader binding", () => {
  const analysis = analyzeJavaScriptStaticSource(`(() => {
    const modules = { 17(module) { module.exports = require("electron"); } };
    function load(id) {
      const module = { exports: {} };
      modules[id](module, module.exports, load);
      return module.exports;
    }
    { const load = userInput; load(99); }
    load(17);
  })();`);
  expect(analysis.bundler_registrations).toMatchObject([
    { entry_module_keys: ["17"] },
  ]);
});

it("preserves first insertion precedence and inclusive interval bounds", () => {
  const nested = new JavaScriptModuleRangeIndex(100);
  expect(nested.find(0)).toBeUndefined();
  nested.add({
    start: 10,
    end: 90,
    key: "outer-first",
    runtime: "webpackChunkApp",
    requireName: null,
  });
  nested.add({
    start: 20,
    end: 30,
    key: "inner-second",
    runtime: "webpackChunkApp",
    requireName: null,
  });
  nested.add({
    start: 30,
    end: 40,
    key: "later-overlap",
    runtime: "webpackChunkApp",
    requireName: null,
  });
  expect(nested.find(9)).toBeUndefined();
  expect(nested.find(10)?.key).toBe("outer-first");
  expect(nested.find(20)?.key).toBe("outer-first");
  expect(nested.find(30)?.key).toBe("outer-first");
  expect(nested.find(90)?.key).toBe("outer-first");
  expect(nested.find(91)).toBeUndefined();
  expect(nested.find(100)).toBeUndefined();
});

it("rejects missing and out-of-range lookup offsets", () => {
  const index = new JavaScriptModuleRangeIndex(20);
  index.add({
    start: 5,
    end: 10,
    key: "bounded",
    runtime: "webpackChunkApp",
    requireName: null,
  });
  expect(index.find(undefined)).toBeUndefined();
  expect(index.find(null)).toBeUndefined();
  expect(index.find(-1)).toBeUndefined();
  expect(index.find(0)).toBeUndefined();
  expect(index.find(11)).toBeUndefined();
  expect(index.find(20)).toBeUndefined();
  expect(index.find(Number.NaN)).toBeUndefined();
  expect(index.find(5)?.key).toBe("bounded");
  expect(index.find(10)?.key).toBe("bounded");
});

it("keeps module references attributed across many real factory ranges", () => {
  const count = 200;
  const factories = Array.from({ length: count }, (_, index) =>
    index === 0
      ? '"module-0": function(module, exports, req) { globalThis.webpackChunkInner.push([[2], { "inner": function(innerModule, innerExports, req) { req("nested-dependency"); } }]); req("dependency-0"); }'
      : `"module-${index}": function(module, exports, req) { req("dependency-${index}"); }`,
  ).join(",\n");
  const analysis = analyzeJavaScriptStaticSource(
    `require("outside");\nglobalThis.webpackChunkApp.push([[1], {\n${factories}\n}]);`,
  );
  expect(analysis.references).toHaveLength(count + 2);
  expect(
    analysis.bundler_registrations.some(
      ({ runtime, modules }) =>
        runtime === "webpackChunkInner" &&
        modules.some(({ module_key }) => module_key === "inner"),
    ),
  ).toBe(true);
  expect(
    analysis.references.find(({ specifier }) => specifier === "outside")
      ?.module_key,
  ).toBeNull();
  for (let index = 0; index < count; index += 1) {
    expect(
      analysis.references.find(
        ({ specifier }) => specifier === `dependency-${index}`,
      ),
    ).toMatchObject({
      module_key: `module-${index}`,
      module_runtime: "webpackChunkApp",
    });
  }
  expect(
    analysis.references.find(
      ({ specifier }) => specifier === "nested-dependency",
    )?.module_key,
  ).toBe("module-0");
});

it("retains the chunk runtime through a TypeScript-only expression wrapper", () => {
  const analysis = analyzeJavaScriptStaticSource(
    '(globalThis.webpackChunkApp satisfies unknown).push([[1], { "entry": function () {} }]);',
  );
  expect(analysis.bundler_registrations).toEqual([
    expect.objectContaining({
      runtime: "webpackChunkApp",
      modules: [expect.objectContaining({ module_key: "entry" })],
    }),
  ]);
});
