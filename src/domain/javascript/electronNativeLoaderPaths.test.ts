import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("native addon loader provenance", () => {
  it("distinguishes CommonJS and ESM re-exports", () => {
    const analysis = analyzeJavaScriptStaticSource(`
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
      const analysis = analyzeJavaScriptStaticSource(`
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
