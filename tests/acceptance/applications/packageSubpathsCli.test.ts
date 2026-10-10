import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "resolves package subpaths with source provenance through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-package-subpaths-");
    const source = [
      'const nearest = require("fixture/parser");',
      'const nested = require("nested/parser");',
      'const parser = require("exported/parser");',
      'const directory = require("exported/parser/");',
      'const hidden = require("exported/hidden");',
      'const missing = require("exported/missing");',
      'new BrowserWindow({webPreferences:{preload:"exported/parser"}});',
    ].join("\n");
    const files = {
      "src/main.cjs": source,
      "src/node_modules/fixture/parser.js": "module.exports = 1;",
      "node_modules/fixture/package.json": "{}",
      "node_modules/fixture/parser.js": "module.exports = 2;",
      "node_modules/nested/package.json": "{}",
      "node_modules/nested/parser/package.json": JSON.stringify({
        main: "./entry.js",
        exports: "./decoy.js",
      }),
      "node_modules/nested/parser/entry.js": "module.exports = 3;",
      "node_modules/nested/parser/index.js": "module.exports = 4;",
      "node_modules/nested/parser/decoy.js": "module.exports = 5;",
      "node_modules/exported/package.json": JSON.stringify({
        exports: {
          "./parser": "./parser.cjs",
          "./parser/": "./parser.cjs",
          "./missing": "./missing.cjs",
        },
      }),
      "node_modules/exported/parser.cjs": "module.exports = 6;",
      "node_modules/exported/hidden.js": "module.exports = 7;",
      "node_modules/exported/missing/index.js": "module.exports = 8;",
    };
    await Promise.all(
      Object.entries(files).map(async ([path, content]) => {
        const absolute = join(root, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
      }),
    );

    const nativeRequire = createRequire(join(root, "src/main.cjs"));
    const expectedTargets = {
      "fixture/parser": "src/node_modules/fixture/parser.js",
      "nested/parser": "node_modules/nested/parser/entry.js",
      "exported/parser": "node_modules/exported/parser.cjs",
    };
    for (const [specifier, target] of Object.entries(expectedTargets))
      expect(
        relative(root, nativeRequire.resolve(specifier)).replaceAll("\\", "/"),
      ).toBe(target);
    for (const specifier of ["exported/parser/", "exported/hidden"])
      expect(() => nativeRequire.resolve(specifier)).toThrow(
        expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
      );
    expect(() => nativeRequire.resolve("exported/missing")).toThrow(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );

    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: ["analyze-javascript-application", root, "--format", "json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(response.exitCode, response.stderr).toBe(0);
      document = response.json;
    } else {
      const { call } = await connectLocalToolsMcp();
      const response = await call("analyze_javascript_application", {
        input_path: root,
        format: "directory",
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      document = response.structuredContent;
    }
    const { graph } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(document).normalized_result;
    const imports = graph.edges.filter(
      ({ properties }) => properties.module_link_kind === "require",
    );
    const sourceDigest = createHash("sha256").update(source).digest("hex");
    for (const [specifier, target] of Object.entries(expectedTargets))
      expect(imports).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            specifier,
            resolved_path: target,
            resolution_status: "resolved",
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({
              available: true,
              sha256: sourceDigest,
            }),
            location: expect.objectContaining({
              available: true,
              value: expect.objectContaining({
                kind: "source-range",
                source: "src/main.cjs",
              }),
            }),
          }),
        }),
      );
    for (const [specifier, status] of [
      ["exported/parser/", "external"],
      ["exported/hidden", "external"],
      ["exported/missing", "not-found"],
    ])
      expect(imports).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            specifier,
            resolved_path: null,
            resolution_status: status,
          }),
        }),
      );
    const preloads = graph.nodes.filter(
      ({ kind }) => kind === "electron-preload",
    );
    expect(preloads).toHaveLength(1);
    expect(preloads[0]?.identity).toMatchObject({
      key: "electron-preload:module-specifier:node_modules/exported/parser.cjs",
    });
    for (const observation of preloads[0]?.observations ?? [])
      expect(observation).toMatchObject({
        properties: {
          declared_path: "exported/parser",
          resolution_context: "module-specifier",
          resolved_path: "node_modules/exported/parser.cjs",
        },
        evidence: {
          location: {
            available: true,
            value: { source: "src/main.cjs", start: { line: 7 } },
          },
        },
      });
  },
);
