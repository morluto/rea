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
    const result = collectWebModuleImports(source, "main.js");
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
  it("excludes whole type declarations and retains inline type dependency syntax", () => {
    const result = collectWebModuleImports(
      'import type {T} from "types"; import {type X} from "also-types"; export type {T} from "export-types"; export {type Y} from "only-types"; import {type T, value} from "mixed"; __webpack_require__.e(4); __vitePreload(() => 1, ["chunk.js"]);',
      "main.ts",
    );
    expect(result.imports.map((item) => item.specifier)).toEqual([
      "also-types",
      "only-types",
      "mixed",
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.stringMatching(
        /compiler options.*unavailable.*type.only.*side.effect/iu,
      ),
    );
  });
  it("keeps JavaScript relational imports distinct from TypeScript import types", () => {
    const source = 'const order = left < import("./dep.js") > (right);';
    const javascript = collectWebModuleImports(source, "main.js");
    expect(javascript.diagnostics).toEqual([]);
    expect(javascript.imports).toEqual([
      expect.objectContaining({
        kind: "dynamic-import",
        specifier: "./dep.js",
        expression: '"./dep.js"',
      }),
    ]);
    expect(collectWebModuleImports(source, "main.ts").imports).toEqual([]);
  });
  it("retains exact import identity and ranges through erased syntax", () => {
    const imports = [
      ['"./dep.js" as const', "./dep.js"],
      ['"./dep.js" satisfies string', "./dep.js"],
      ['"./dep.js"!', "./dep.js"],
      ["`./dep.js` as const", "./dep.js"],
      ["`./${name}.js` as const", null],
    ] as const;
    const source = imports
      .map(([expression]) => `import(${expression});`)
      .join("\n");
    expect(collectWebModuleImports(source, "main.ts")).toEqual({
      state: "parsed",
      diagnostics: [],
      imports: imports.map(([expression, specifier], index) => {
        const offset = source.indexOf(expression);
        return {
          kind: "dynamic-import",
          specifier,
          expression,
          start: { offset, line: index + 1, column: 7 },
          end: {
            offset: offset + expression.length,
            line: index + 1,
            column: 7 + expression.length,
          },
        };
      }),
    });
  });
  it("reports unparseable input without asserting an empty complete graph", () => {
    const result = collectWebModuleImports(
      'import "./ok.js"; function {',
      "main.js",
    );
    expect(result).toMatchObject({ state: "unparseable", imports: [] });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("deep native module syntax", () => {
  it("retains imports and their locations after a parser-admitted deep property chain", () => {
    const source = `const value = root${".next".repeat(12_000)};\nimport "./last.js";\nexport * from "./reexport.js";\nimport("./lazy.js");`;
    const result = collectWebModuleImports(source, "main.js");
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
  it("retains exact capture versions and separates query and weaker fragment matches", () => {
    const url = "https://app.test/a.js?v=1";
    const scripts = [
      script(`${url}#one`, "page-script"),
      script(`${url}#two`, "page-script"),
      script(url, "scenario-response"),
      script(url, "scenario-response", "b".repeat(64)),
      script("https://app.test/a.js?v=2", "scenario-response"),
    ];
    expect(matchCapturedModules(url, scripts)).toEqual([
      { script_index: 2, match: "exact-reported-url", script: scripts[2] },
      { script_index: 3, match: "exact-reported-url", script: scripts[3] },
    ]);
    expect(matchCapturedModules(`${url}#one`, scripts)).toEqual([
      { script_index: 0, match: "exact-reported-url", script: scripts[0] },
      {
        script_index: 2,
        match: "response-url-without-fragment",
        script: scripts[2],
      },
      {
        script_index: 3,
        match: "response-url-without-fragment",
        script: scripts[3],
      },
    ]);
    expect(matchCapturedModules("https://app.test/lazy.js", scripts)).toEqual(
      [],
    );
  });
  it("retains exact non-URL identities without matching response fragments", () => {
    const scripts = [
      script("relative/module.js#part", "page-script"),
      script("relative/module.js#part", "scenario-response"),
      script("relative/module.js", "scenario-response"),
    ];
    expect(
      matchCapturedModules("relative/module.js#part", scripts).map((item) => [
        item.script_index,
        item.match,
      ]),
    ).toEqual([
      [0, "exact-reported-url"],
      [1, "exact-reported-url"],
    ]);
  });
});

it.each(["main.mjs", "main.js", "view.jsx"])(
  "retains original expression offsets for a BOM-prefixed hashbang in %s",
  (path) => {
    const source =
      '\uFEFF#!/usr/bin/env node\r\nconst face = "😀"; import "./dep.mjs"; import(`./${part}.mjs`);';
    const result = collectWebModuleImports(source, path);
    expect(result.state).toBe("parsed");
    expect(result.diagnostics).toEqual(
      path === "main.js"
        ? [expect.stringContaining("package loader mode is unknown")]
        : [],
    );
    expect(result.imports.map(({ expression }) => expression)).toEqual([
      '"./dep.mjs"',
      "`./${part}.mjs`",
    ]);
    for (const item of result.imports) {
      expect(item.start.offset).toBe(source.indexOf(item.expression));
      expect(source.slice(item.start.offset, item.end.offset)).toBe(
        item.expression,
      );
      expect(item.start.line).toBe(2);
      expect(item.start.column).toBe(
        source.split("\r\n")[1]!.indexOf(item.expression),
      );
    }
  },
);
