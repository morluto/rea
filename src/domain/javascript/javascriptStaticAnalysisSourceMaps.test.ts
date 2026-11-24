import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";

const sourceMapUrls = (source: string): readonly string[] =>
  analyzeJavaScriptStaticSource(source).source_map_urls.map(
    ({ declared_url: declaredUrl }) => declaredUrl,
  );

describe("source map directives", () => {
  it("retains every line and block directive with its exact URL and range", () => {
    const cases = [
      { marker: "//#", url: "app*part.js.map", suffix: "" },
      { marker: "//@", url: "legacy.map", suffix: "" },
      { marker: "/*#", url: "vendor*part.js.map", suffix: " */" },
      { marker: "/*@", url: "*leading.map", suffix: "*/", prefix: "code(); " },
      { marker: "/*#", url: "trailing.map*", suffix: "*/" },
      { marker: "/*#", url: "**double.map", suffix: " */" },
      { marker: "/*#", url: "plain.map", suffix: "*/" },
    ];
    const directives = cases.map(({ marker, url, suffix, prefix = "" }) => ({
      url,
      prefix,
      comment: `${marker} sourceMappingURL=${url}`,
      suffix,
    }));
    const source = directives
      .map(({ prefix, comment, suffix }) => prefix + comment + suffix)
      .join("\n");
    const result = analyzeJavaScriptStaticSource(source);
    expect(result.source_map_urls).toEqual(
      directives.map(({ url, prefix, comment }, index) => ({
        declared_url: url,
        location: {
          start: { line: index + 1, column: prefix.length },
          end: { line: index + 1, column: prefix.length + comment.length },
        },
      })),
    );
  });

  it("reads a large inline map from a two-byte source without overflowing", () => {
    const declared =
      "data:application/json;charset=utf-8;base64," + "A".repeat(9_000_000);
    const source = `const label = "ğ";\n//# sourceMappingURL=${declared}`;

    expect(sourceMapUrls(source)).toEqual([declared]);
  });

  it.each([
    ["after the marker", "//#", "sourceMappingURL=x"],
    ["before the equals sign", "//# sourceMappingURL", "=x"],
    ["before the URL", "//# sourceMappingURL=", "x"],
  ])("reads 9.5M spaces %s without overflowing", (_label, prefix, suffix) => {
    const source = `ğ${prefix}${" ".repeat(9_500_000)}${suffix}`;
    expect(analyzeJavaScriptStaticSource(source).source_map_urls).toEqual([
      {
        declared_url: "x",
        location: {
          start: { line: 1, column: 1 },
          end: { line: 1, column: source.length },
        },
      },
    ]);
  });

  it.each([
    "//# \t",
    "//# sourceMappingURL \t",
    "//# sourceMappingURL= \t",
    "/*# sourceMappingURL= */",
    "//# sourceMappingURLx=app.js.map",
    "//# sourceMappingURL app.js.map",
  ])("ignores an incomplete or malformed directive: %s", (source) => {
    expect(sourceMapUrls(source)).toEqual([]);
  });

  it("preserves Unicode whitespace and URL terminator boundaries", () => {
    const source =
      "ğ/*@\u00a0sourceMappingURL\u2003=\ufeffapp.js.map* ignored */";
    const declaredEnd = source.indexOf(" ignored");
    expect(analyzeJavaScriptStaticSource(source).source_map_urls).toEqual([
      {
        declared_url: "app.js.map*",
        location: {
          start: { line: 1, column: 1 },
          end: { line: 1, column: declaredEnd },
        },
      },
    ]);
  });
});

describe("source map comment boundaries", () => {
  it("ignores comment markers in JavaScript literals and ordinary comments", () => {
    const source = [
      'const documentation = "/*# sourceMappingURL=ghost.map */";',
      "const template = `//# sourceMappingURL=ghost.map `;",
      "const pattern = /[//# sourceMappingURL=ghost.map ]/;",
      "/* Documentation example: //# sourceMappingURL=ghost.map */",
    ].join("\n");
    const result = analyzeJavaScriptStaticSource(source);
    expect(result.parse_status).toBe("complete");
    expect(result.source_map_urls).toEqual([]);
  });

  it.each([
    "const view = <div>//# sourceMappingURL=ghost.map </div>;",
    'const documentation: string = "//# sourceMappingURL=ghost.map ";',
  ])("ignores comment markers inside supported syntax: %s", (source) => {
    const result = analyzeJavaScriptStaticSource(source);
    expect(result.parse_status).toBe("complete");
    expect(result.source_map_urls).toEqual([]);
  });

  it.each([
    "const value: number = 1;\n//# sourceMappingURL=typed.map",
    "const view = <div />;\n//# sourceMappingURL=typed.map",
    "const text = `${(() => { /*# sourceMappingURL=typed.map */ return 1; })()}`;",
  ])("keeps authentic comments in supported syntax: %s", (source) => {
    expect(sourceMapUrls(source)).toEqual(["typed.map"]);
  });
});

describe("source map comment locations and recovery", () => {
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
