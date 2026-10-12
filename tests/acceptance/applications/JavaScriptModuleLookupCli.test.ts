import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const execute = promisify(execFile);

const createModuleLookupFixture = async () => {
  const root = await createTestTempDirectory("rea-module-lookup-");
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({ name: "module-lookup-fixture" }),
    "esm/entry.mjs": [
      'import "./extensionless";',
      'import "./directory";',
      'import "./explicit.js";',
      'import "./exact.js";',
      'import fallback from "empty-main";',
      'import "nested-main";',
      "void fallback;",
    ].join("\n"),
    "esm/extensionless.js": "module.exports = 1;",
    "esm/directory/index.js": "module.exports = 2;",
    "esm/explicit.js.js": "module.exports = 3;",
    "esm/exact.js": "module.exports = 4;",
    "cjs/entry.cjs": [
      'require("./extensionless");',
      'require("./feature");',
      'require("./feature.cjs");',
      'require("./default-js");',
      'require("./default-json");',
      'require("./default-node");',
      'require("empty-main");',
      'require("nested-main");',
    ].join("\n"),
    "cjs/extensionless.cjs": "module.exports = 1;",
    "cjs/feature.cjs": "module.exports = 2;",
    "cjs/default-js.js": "module.exports = 3;",
    "cjs/default-json.json": JSON.stringify({ value: 4 }),
    // Inventory-only placeholder: never pass this path to Node's runtime.
    "cjs/default-node.node": "source-owned opaque native-module placeholder",
    "node_modules/empty-main/package.json": JSON.stringify({ main: "" }),
    "node_modules/empty-main/index.js": "module.exports = 42;",
    "node_modules/nested-main/package.json": JSON.stringify({ main: "sub" }),
    "node_modules/nested-main/sub/package.json": JSON.stringify({
      main: "other",
    }),
    "node_modules/nested-main/sub/other.js": "module.exports = 99;",
    "runtime-control.mjs": [
      'const specifiers = ["./esm/extensionless", "./esm/directory", "./esm/explicit.js", "./esm/exact.js", "empty-main", "nested-main"];',
      "const results = [];",
      "for (const specifier of specifiers) {",
      "  try { await import(specifier); results.push({ specifier, ok: true }); }",
      "  catch (error) { results.push({ specifier, ok: false, code: error.code }); }",
      "}",
      "console.log(JSON.stringify(results));",
    ].join("\n"),
    "runtime-control.cjs": [
      'const specifiers = ["./cjs/extensionless", "./cjs/feature", "./cjs/feature.cjs", "./cjs/default-js", "./cjs/default-json", "empty-main", "nested-main"];',
      "const results = [];",
      "for (const specifier of specifiers) {",
      "  try { require(specifier); results.push({ specifier, ok: true }); }",
      "  catch (error) { results.push({ specifier, ok: false, code: error.code }); }",
      "}",
      "console.log(JSON.stringify(results));",
    ].join("\n"),
  });
  return root;
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "matches Node module lookup for ESM and CommonJS through %s",
  async (surface, { cli }) => {
    const root = await createModuleLookupFixture();
    const [esmControl, cjsControl] = await Promise.all([
      execute(process.execPath, ["runtime-control.mjs"], {
        cwd: root,
        timeout: 5_000,
      }),
      execute(process.execPath, ["runtime-control.cjs"], {
        cwd: root,
        timeout: 5_000,
      }),
    ]);
    const esmResults = JSON.parse(esmControl.stdout) as Array<{
      readonly specifier: string;
      readonly ok: boolean;
      readonly code?: string;
    }>;
    const cjsResults = JSON.parse(cjsControl.stdout) as Array<{
      readonly specifier: string;
      readonly ok: boolean;
      readonly code?: string;
    }>;
    expect(esmResults).toEqual([
      {
        specifier: "./esm/extensionless",
        ok: false,
        code: "ERR_MODULE_NOT_FOUND",
      },
      {
        specifier: "./esm/directory",
        ok: false,
        code: "ERR_UNSUPPORTED_DIR_IMPORT",
      },
      {
        specifier: "./esm/explicit.js",
        ok: false,
        code: "ERR_MODULE_NOT_FOUND",
      },
      { specifier: "./esm/exact.js", ok: true },
      { specifier: "empty-main", ok: true },
      { specifier: "nested-main", ok: false, code: "ERR_MODULE_NOT_FOUND" },
    ]);
    expect(cjsResults).toEqual([
      {
        specifier: "./cjs/extensionless",
        ok: false,
        code: "MODULE_NOT_FOUND",
      },
      {
        specifier: "./cjs/feature",
        ok: false,
        code: "MODULE_NOT_FOUND",
      },
      { specifier: "./cjs/feature.cjs", ok: true },
      { specifier: "./cjs/default-js", ok: true },
      { specifier: "./cjs/default-json", ok: true },
      { specifier: "empty-main", ok: true },
      { specifier: "nested-main", ok: false, code: "MODULE_NOT_FOUND" },
    ]);

    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const expectations = [
      ["import", "./extensionless", null, "not-found"],
      ["import", "./directory", null, "not-found"],
      ["import", "./explicit.js", null, "not-found"],
      ["import", "./exact.js", "esm/exact.js", "resolved"],
      ["import", "empty-main", "node_modules/empty-main/index.js", "resolved"],
      ["import", "nested-main", null, "not-found"],
      ["require", "./extensionless", null, "not-found"],
      ["require", "./feature", null, "not-found"],
      ["require", "./feature.cjs", "cjs/feature.cjs", "resolved"],
      ["require", "./default-js", "cjs/default-js.js", "resolved"],
      ["require", "./default-json", "cjs/default-json.json", "resolved"],
      ["require", "./default-node", "cjs/default-node.node", "resolved"],
      ["require", "empty-main", "node_modules/empty-main/index.js", "resolved"],
      ["require", "nested-main", null, "not-found"],
    ] as const;

    for (const [kind, specifier, resolvedPath, status] of expectations)
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            module_link_kind: kind,
            specifier,
            resolved_path: resolvedPath,
            resolution_status: status,
          }),
        }),
      );
  },
);
