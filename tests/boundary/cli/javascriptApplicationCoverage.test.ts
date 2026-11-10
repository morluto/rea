import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest(
  "reports complete coverage for a parsed module without Electron identity whose hoisted read precedes its initializer",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-coverage-hoisted-read-");
    await writeFixtureFiles(root, {
      "index.js": [
        "function schedule(callback) {",
        "  return scheduleTimeout(callback, 0);",
        "}",
        'var scheduleTimeout = "function" === typeof setTimeout ? setTimeout : void 0;',
        "module.exports = { schedule };",
        "",
      ].join("\n"),
    });
    const application = await analyzeJavaScriptDirectory("CLI", cli, root);

    expect(application.statistics).toMatchObject({
      parsed_javascript_files: 1,
      parse_failures: 0,
    });
    const source = application.graph.nodes
      .flatMap((node) => node.observations)
      .find((observation) => observation.properties.file_kind === "javascript");
    expect(source?.properties.parse_status).toBe("complete");
    expect(application.graph.coverage).toEqual({
      status: "complete",
      truncated: false,
      omitted_count: 0,
      limits: [],
    });
  },
);

for (const surface of ["CLI", "stdio MCP"] as const) {
  cliTest(
    `retains inherited loader uncertainty through ${surface}`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-js-inherited-loader-");
      await writeFixtureFiles(root, {
        "index.js": `Object.prototype.load = require;
        function register() { load("electron").ipcMain.on("ping", () => {}); }
        var load = [].load;
        register();`,
      });
      const application = await analyzeJavaScriptDirectory(surface, cli, root);
      const source = application.graph.nodes
        .flatMap((node) => node.observations)
        .find(
          (observation) => observation.properties.file_kind === "javascript",
        );

      expect(source?.properties.parse_status).toBe("partial");
      expect(application.graph.coverage.status).toBe("partial");
    },
  );

  cliTest(
    `retains bridge paths after alias replacement through ${surface}`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-js-replaced-alias-");
      await writeFixtureFiles(root, {
        "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
        const base = { ping: () => ipcRenderer.send("ping") };
        let alias = base;
        alias = {};
        alias.other = 1;
        contextBridge.exposeInMainWorld("api", base);`,
      });
      const application = await analyzeJavaScriptDirectory(surface, cli, root);
      const observations = application.graph.nodes.flatMap(
        (node) => node.observations,
      );

      expect(observations).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            entry: "api.ping",
            entry_kind: "bridge-member",
            step_kind: "terminal",
          }),
        }),
      );
    },
  );
}
