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

const quotedDirectiveSources = [
  'const documentation = "//# sourceMappingURL=ghost.map ";',
  'const documentation = "/*# sourceMappingURL=ghost.map */";',
  "const documentation = `//# sourceMappingURL=ghost.map `;",
  "const pattern = /[//# sourceMappingURL=ghost.map ]/;",
  "const view = <div>//# sourceMappingURL=ghost.map </div>;",
  'const documentation: string = "//# sourceMappingURL=ghost.map ";',
  "/* Documentation example: //# sourceMappingURL=ghost.map */",
];

describe("source map comment boundaries", () => {
  it.each(quotedDirectiveSources)(
    "does not read a directive from %s",
    (source) => {
      const result = analyzeJavaScriptStaticSource(source);
      expect(result.parse_status).toBe("complete");
      expect(result.source_map_urls).toEqual([]);
    },
  );

  it("retains only the real trailing directive after quoted examples", () => {
    expect(
      sourceMapUrls(
        [
          quotedDirectiveSources[0],
          "const template = `/*# sourceMappingURL=template.map */`;",
          "//# sourceMappingURL=real.map",
        ].join("\n"),
      ),
    ).toEqual(["real.map"]);
  });

  it.each([
    "const value: number = 1;\n//# sourceMappingURL=typed.map",
    "const view = <div />;\n//# sourceMappingURL=typed.map",
    "const value = 1; /*@ sourceMappingURL=typed.map */",
    "const text = `${(() => { /*# sourceMappingURL=typed.map */ return 1; })()}`;",
  ])("keeps authentic comments in supported syntax: %s", (source) => {
    expect(sourceMapUrls(source)).toEqual(["typed.map"]);
  });
});

describe("source map comment locations and recovery", () => {
  it("keeps exact locations and the first occurrence of duplicate URLs", () => {
    const line = "//# sourceMappingURL=first.map";
    const block = "/*# sourceMappingURL=second.map";
    const result = analyzeJavaScriptStaticSource(
      ['const marker = "😀";', line, `${block} */`, line].join("\r\n"),
    );
    expect(result.source_map_urls).toEqual([
      {
        declared_url: "first.map",
        location: {
          start: { line: 2, column: 0 },
          end: { line: 2, column: line.length },
        },
      },
      {
        declared_url: "second.map",
        location: {
          start: { line: 3, column: 0 },
          end: { line: 3, column: block.length },
        },
      },
    ]);
  });

  it("keeps real comments when the parser recovers and reports partial syntax", () => {
    const result = analyzeJavaScriptStaticSource(
      "let value; let value;\n//# sourceMappingURL=recovered.map",
    );
    expect(result.parse_status).toBe("partial");
    expect(result.parse_error_count).toBeGreaterThan(0);
    expect(
      result.source_map_urls.map(({ declared_url }) => declared_url),
    ).toEqual(["recovered.map"]);
  });

  it("preserves the failed result when source cannot be parsed", () => {
    const result = analyzeJavaScriptStaticSource(
      "const value = ;\n//# sourceMappingURL=unparsed.map",
    );
    expect(result.parse_status).toBe("failed");
    expect(result.source_map_urls).toEqual([]);
  });
});
