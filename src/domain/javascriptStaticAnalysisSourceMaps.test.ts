import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const sourceMapUrls = (source: string): readonly string[] =>
  analyzeJavaScriptStaticSource(source).source_map_urls.map(
    ({ declared_url: declaredUrl }) => declaredUrl,
  );

describe("source map directives", () => {
  it.each([
    ["line comment", "//# sourceMappingURL=app.js.map", "app.js.map"],
    ["legacy line comment", "//@ sourceMappingURL=app.js.map", "app.js.map"],
    // Minifiers commonly emit the block form; it previously matched nothing.
    ["block comment", "/*# sourceMappingURL=app.js.map */", "app.js.map"],
    [
      "block comment after code",
      "code();\n/*# sourceMappingURL=vendor.abc.map */",
      "vendor.abc.map",
    ],
  ])("reads the %s form", (_label, source, expected) => {
    expect(sourceMapUrls(source)).toEqual([expected]);
  });

  it("keeps the comment terminator out of the declared url", () => {
    expect(sourceMapUrls("/*# sourceMappingURL=app.js.map */")).toEqual([
      "app.js.map",
    ]);
  });

  it("retains every directive in a source", () => {
    expect(
      sourceMapUrls(
        "//# sourceMappingURL=first.map\n/*# sourceMappingURL=second.map */",
      ),
    ).toEqual(["first.map", "second.map"]);
  });

  it("reports nothing when no directive is present", () => {
    expect(sourceMapUrls("const value = 1;")).toEqual([]);
  });
});
