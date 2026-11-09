import { describe, expect, it } from "vitest";

import { analyzeCommonJsStaticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";

// A `.js` fixture parses as ESM, and then every `require` call keeps only
// candidate loader authority. These cases describe CommonJS packaging, so they
// use the CommonJS fixture that the sibling Electron paths also rely on.
const analyze = (source: string) => analyzeCommonJsStaticFixture(source);

describe("node:vm bytecode cache boundaries", () => {
  it("records the artifact named by an inert readFileSync cache argument", () => {
    const analysis = analyze(`
      const fs = require("node:fs");
      const path = require("node:path");
      const vm = require("node:vm");
      const cachedData = fs.readFileSync(path.join(__dirname, "preload.bundle.cache"));
      new vm.Script(sourcePlaceholder, { cachedData }).runInThisContext();
    `);
    expect(analysis.electron.dynamic_code).toEqual([
      expect.objectContaining({
        api: "vm.Script",
        cached_data_status: "declared",
        cached_data: {
          source_path: "preload.bundle.cache",
          source_resolution_context: "filesystem-expression",
          source_expression: null,
        },
        source_text: expect.objectContaining({
          expression: "sourcePlaceholder",
        }),
      }),
    ]);
  });

  it("resolves compileFunction's positional cachedData argument", () => {
    const analysis = analyze(`
      const vm = require("node:vm");
      vm.compileFunction(text, [], { cachedData: loadCache() });
    `);
    expect(analysis.electron.dynamic_code).toEqual([
      expect.objectContaining({
        api: "vm.compileFunction",
        cached_data_status: "declared",
        cached_data: expect.objectContaining({
          source_path: null,
          source_expression: "loadCache()",
        }),
      }),
    ]);
  });

  it("keeps compilations without a bytecode cache as compilations without declared cachedData", () => {
    const analysis = analyze(`
      const vm = require("node:vm");
      new vm.Script("./main.js");
    `);
    expect(analysis.electron.dynamic_code).toEqual([
      expect.objectContaining({
        api: "vm.Script",
        cached_data_status: "absent",
      }),
    ]);
  });

  // A local object named `vm` is not the module, so its members name no VM API.
  it("ignores an unrelated local object that shares the module name", () => {
    const analysis = analyze(`
      const vm = { Script: class Script {} };
      new vm.Script("./main.js", { cachedData: "x" });
    `);
    expect(analysis.electron.dynamic_code ?? []).toEqual([]);
  });
});

it("preserves unknown options and conservative constant-option reads without claiming execution", () => {
  for (const [source, status] of [
    ['new vm.Script("x", options);', "unknown"],
    [
      'const options = { cachedData: "./cache" }; new vm.Script("x", options);',
      "unknown",
    ],
    ['new vm.Script("x", { cachedData: value, ...options });', "unknown"],
    ['new vm.Script("x", { ...options, cachedData: value });', "declared"],
  ]) {
    const result = analyze('const vm = require("node:vm"); ' + source);
    expect(result.electron.dynamic_code?.[0], source).toMatchObject({
      cached_data_status: status,
      cached_data: { source_path: null },
    });
  }
});
