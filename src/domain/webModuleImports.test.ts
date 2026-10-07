import { describe, expect, it } from "vitest";
import {
  collectWebModuleImports,
  matchCapturedModules,
} from "./webModuleImports.js";
import { exportedWebScriptSchema } from "./webScriptExport.js";

describe("native module syntax observations", () => {
  it("collects native imports and re-exports, preserving empty strings and computed unknowns", () => {
    const source =
      'import ""; import x from "./x.js"; export * from "./all.js"; export {x} from "pkg"; import(`./literal.js`); import(`./${name}.js`); import(expr);';
    const result = collectWebModuleImports(source);
    expect(result.state).toBe("parsed");
    expect(result.imports.map((item) => [item.kind, item.specifier])).toEqual([
      ["static-import", ""],
      ["static-import", "./x.js"],
      ["re-export", "./all.js"],
      ["re-export", "pkg"],
      ["dynamic-import", "./literal.js"],
      ["dynamic-import", null],
      ["dynamic-import", null],
    ]);
    for (const item of result.imports)
      expect(source.slice(item.start.offset, item.end.offset)).toBe(
        item.expression,
      );
  });
  it("excludes erased TypeScript imports/exports and bundler inference", () => {
    const result = collectWebModuleImports(
      'import type {T} from "types"; import {type X} from "also-types"; export type {T} from "export-types"; export {type Y} from "only-types"; import {type T, value} from "mixed"; __webpack_require__.e(4); __vitePreload(() => 1, ["chunk.js"]);',
    );
    expect(result.imports.map((item) => item.specifier)).toEqual(["mixed"]);
  });
  it("uses UTF-16 source locations after astral characters", () => {
    const source = 'const emoji = "😀";\nimport "./x.js";';
    const item = collectWebModuleImports(source).imports[0];
    expect(item?.start).toEqual({
      offset: source.indexOf('"./x.js"'),
      line: 2,
      column: 7,
    });
  });
  it("reports unparseable input without asserting an empty complete graph", () => {
    const result = collectWebModuleImports('import "./ok.js"; function {');
    expect(result).toMatchObject({ state: "unparseable", imports: [] });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("deep native module syntax", () => {
  it("retains imports and their locations after a parser-admitted deep property chain", () => {
    const source = `const value = root${".next".repeat(12_000)};\nimport "./last.js";\nexport * from "./reexport.js";\nimport("./lazy.js");`;
    const result = collectWebModuleImports(source);
    expect(result.state).toBe("parsed");
    expect(result.diagnostics).toEqual([]);
    expect(
      result.imports.map(({ kind, specifier }) => [kind, specifier]),
    ).toEqual([
      ["static-import", "./last.js"],
      ["re-export", "./reexport.js"],
      ["dynamic-import", "./lazy.js"],
    ]);
    for (const item of result.imports)
      expect(source.slice(item.start.offset, item.end.offset)).toBe(
        item.expression,
      );
    expect(result.imports[0]?.start).toEqual({
      offset: source.indexOf('"./last.js"'),
      line: 2,
      column: 7,
    });
  });
});

const script = (
  url: string,
  kind: "page-script" | "scenario-response",
  sha256 = "a".repeat(64),
) =>
  exportedWebScriptSchema.parse({
    url,
    source:
      kind === "page-script"
        ? {
            kind,
            script_key: "script1",
            frame_id: null,
            is_module: true,
            language: "JavaScript",
            source_map_url: null,
          }
        : {
            kind,
            transaction_id: "txn",
            request_sequence: 1,
            response_sequence: 2,
            status: 200,
          },
    content: {
      state: "exported",
      relative_path: "modules/a.js",
      layout: "isolated",
      layout_reason: "fixture",
      sha256,
      bytes: 1,
      media_type: "text/javascript",
      redacted: false,
      representation:
        kind === "page-script"
          ? "debugger-source-utf8"
          : "browser-decoded-response-bytes",
    },
  });
describe("captured module candidates", () => {
  it("keeps query versions separate and response fragment matching weaker", () => {
    const scripts = [
      script("https://app.test/a.js?v=1#one", "page-script"),
      script("https://app.test/a.js?v=1#two", "page-script"),
      script("https://app.test/a.js?v=1", "scenario-response"),
      script("https://app.test/a.js?v=2", "scenario-response"),
    ];
    expect(
      matchCapturedModules("https://app.test/a.js?v=1#one", scripts).map(
        (item) => [item.script_index, item.match],
      ),
    ).toEqual([
      [0, "exact-reported-url"],
      [2, "response-url-without-fragment"],
    ]);
  });
  it("preserves every captured version at the same URL and never picks one", () => {
    const url = "https://app.test/a.js";
    const candidates = matchCapturedModules(url, [
      script(url, "scenario-response"),
      script(url, "scenario-response", "b".repeat(64)),
    ]);
    expect(candidates).toHaveLength(2);
    expect(
      matchCapturedModules(
        "https://app.test/lazy.js",
        candidates.map((item) => item.script),
      ),
    ).toEqual([]);
  });
});
