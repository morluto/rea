import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps package context conditional for uppercase source suffixes through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-package-suffix-case-");
    const source = 'require("./dep.cjs");';
    await writeFixtureFiles(root, {
      "common/package.json": '{"type":"commonjs"}',
      "common/entry.JS": source,
      "common/entry.TS": source,
      "common/lower.js": source,
      "common/dep.cjs": "module.exports = {};",
      "module/package.json": '{"type":"module"}',
      "module/entry.JS": source,
      "module/entry.TS": source,
      "module/ordinary.js": "console.log('module');",
      "module/main.mjs":
        'import {BrowserWindow} from "electron"; import {fileURLToPath} from "node:url"; new BrowserWindow({webPreferences:{sandbox:false,preload:fileURLToPath(new URL("./entry.JS",import.meta.url))}});',
      "module/dep.cjs": "module.exports = {};",
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    for (const source of [
      "common/entry.JS",
      "common/entry.TS",
      "module/entry.JS",
      "module/entry.TS",
    ]) {
      const edges = result.graph.edges.filter(
        ({ relation, properties, evidence }) =>
          relation === "imports" &&
          properties.specifier === "./dep.cjs" &&
          properties.loader_authority === "candidate" &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === source,
      );
      expect(edges.length, source).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.properties.resolved_path, source).toBeNull();
        expect(edge.evidence.confidence, source).toBe("low");
      }
    }
    expect(result.graph.edges).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          specifier: "./dep.cjs",
          resolved_path: "common/dep.cjs",
        }),
        evidence: expect.objectContaining({
          location: expect.objectContaining({
            value: expect.objectContaining({ source: "common/lower.js" }),
          }),
        }),
      }),
    );
  },
);
