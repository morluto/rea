import { describe, expect, it } from "vitest";

import { analyzeCommonJsStaticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("native addon type-only TypeScript imports", () => {
  it("ignores declaration-wide import type and export type from .node modules", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      import type { NativeThing } from "./addon.node";
      export type { Extra } from "./addon.node";
    `);
    expect(analysis.parse_status).toBe("complete");
    expect(analysis.electron.native_addon_bindings).toEqual([]);
  });

  it("keeps only value members from mixed type/value native imports", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      import { type OtherThing, load } from "./addon.node";
      load();
    `);
    expect(analysis.electron.native_addon_bindings).toEqual([
      expect.objectContaining({
        specifier: "./addon.node",
        binding_kind: "import",
        members: ["load"],
      }),
    ]);
  });

  it("retains ordinary value imports of native addons", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      import { load } from "./addon.node";
      load();
    `);
    expect(analysis.electron.native_addon_bindings).toEqual([
      expect.objectContaining({
        specifier: "./addon.node",
        binding_kind: "import",
        members: ["load"],
      }),
    ]);
  });
});

describe("native addon type-only re-exports", () => {
  it.each([
    ['export { type Extra, load } from "./addon.node";', ["load"]],
    ['export { type Extra } from "./addon.node";', []],
    ['export type * from "./addon.node";', []],
  ] as const)("retains only runtime members from %s", (source, members) => {
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.parse_status).toBe("complete");
    expect(analysis.electron.native_addon_bindings).toEqual(
      members.length === 0
        ? []
        : [
            expect.objectContaining({
              specifier: "./addon.node",
              binding_kind: "re-export",
              members: [...members],
            }),
          ],
    );
  });
});

it("does not claim a native re-export from a candidate wrapper with a proven factory loader", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    globalThis.webpackChunkApp.push([[1], {
      "factory": function (m, e, load) {
        const known = load("./known.node");
        module.exports = load("./addon.node");
      }
    }]);
  `);
  expect(analysis.electron.native_addon_bindings).toContainEqual(
    expect.objectContaining({
      binding_kind: "require",
      specifier: "./known.node",
    }),
  );
  expect(analysis.electron.native_addon_bindings).not.toContainEqual(
    expect.objectContaining({
      binding_kind: "re-export",
      specifier: "./addon.node",
    }),
  );
  expect(
    analysis.analysis_coverage?.semantics.unknown_findings,
  ).toBeGreaterThan(0);
});

describe("native addon loader provenance", () => {
  it("does not give ESM fixtures an ambient CommonJS loader", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      import imported from "./addon.node";
      const required = require("./other.node");
      module.exports = require("./exported.node");
    `);
    expect(analysis.electron.native_addon_bindings).toEqual([
      expect.objectContaining({
        specifier: "./addon.node",
        binding_kind: "import",
        module_kind: "import",
      }),
    ]);
  });

  it("distinguishes CommonJS and ESM re-exports", () => {
    const analysis = analyzeCommonJsStaticFixture(`
      const required = require("./addon.node#literal.node");
      module.exports = require("./addon.node#literal.node");
      import imported from "./addon.node#literal.node";
      export { default } from "./addon.node#literal.node";
    `);
    expect(analysis.electron.native_addon_bindings).toHaveLength(4);
    expect(analysis.electron.native_addon_bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding_kind: "require",
          module_kind: "require",
        }),
        expect.objectContaining({
          binding_kind: "import",
          module_kind: "import",
        }),
        expect.objectContaining({
          binding_kind: "re-export",
          module_kind: "require",
        }),
        expect.objectContaining({
          binding_kind: "re-export",
          module_kind: "import",
        }),
      ]),
    );
  });

  it.each(["#", "?"])(
    "classifies require filenames literally for %s",
    (punctuation) => {
      const analysis = analyzeCommonJsStaticFixture(`
      const script = require("./addon.node${punctuation}helper.js");
      import native from "./addon.node${punctuation}helper.js";
    `);
      expect(analysis.electron.native_addon_bindings).toEqual([
        expect.objectContaining({
          binding_kind: "import",
          module_kind: "import",
        }),
      ]);
    },
  );
});

it.each(["call", "apply"])(
  "does not prove native bindings through a replaced require.%s",
  (method) => {
    const argument =
      method === "call" ? 'null,"./addon.node"' : 'null,["./addon.node"]';
    const replaced = analyzeCommonJsStaticFixture(
      `require.${method}=custom;const addon=require.${method}(${argument});`,
    );
    expect(replaced.electron.native_addon_bindings).toEqual([]);
    const intact = analyzeCommonJsStaticFixture(
      `require.other=custom;const addon=require.${method}(${argument});`,
    );
    expect(intact.electron.native_addon_bindings).toMatchObject([
      { specifier: "./addon.node", binding_kind: "require" },
    ]);
  },
);

it("does not prove native bindings through a replaced aliased loader member", () => {
  const analysis = analyzeCommonJsStaticFixture(
    'const load=require;load.call=custom;const addon=load.call(null,"./addon.node");',
  );
  expect(analysis.electron.native_addon_bindings).toEqual([]);
});
