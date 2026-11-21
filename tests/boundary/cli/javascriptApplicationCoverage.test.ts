import { createHash } from "node:crypto";
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
    `counts proven Electron facts beside exhausted receiver selections through ${surface}`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-js-alias-coverage-");
      await writeFixtureFiles(root, {
        "main.cjs": `
          (() => {
            const table = {
              1: module => { module.exports = require("electron"); },
              2: (module, exports, load) => {
                const electron = load(1);
                new electron.BrowserWindow({ webPreferences: { sandbox: true } });
                electron.ipcMain.handle("ready", () => 1);
              }
            };
            const cache = {};
            function load(id) {
              const cached = cache[id];
              if (cached) return cached.exports;
              const module = cache[id] = { exports: {} };
              table[id](module, module.exports, load);
              return module.exports;
            }
            let receiver = {};
            while (flag) receiver = receiver[key];
            receiver[key] = 0;
            load(2);
          })();
        `,
      });
      const application = await analyzeJavaScriptDirectory(surface, cli, root);

      expect(application.summary).toMatchObject({
        electron_semantics: "partial",
        browser_windows: 1,
        explicit_web_preferences: 1,
        ipc: { operations: 1, main_handlers: 1 },
      });
      expect(application.graph.coverage).toMatchObject({
        status: "partial",
        limits: expect.arrayContaining([
          expect.objectContaining({
            name: "javascript_semantic_alias_selections",
            value: 512,
          }),
        ]),
      });
    },
  );

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

for (const surface of ["CLI", "stdio MCP"] as const) {
  cliTest(
    `retains a Webpack external outside the finite written slots through ${surface}`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-webpack-slot-coverage-");
      const source = `(() => {
        const table = {
          1: module => { module.exports = require("electron"); },
          2: (module, exports, load) => {
            const electron = load(1);
            new electron.BrowserWindow({});
            electron.ipcMain.handle("ready", () => {});
          }
        };
        function load(key) {
          const module = { exports: {} };
          table[key](module, module.exports, load);
          return module.exports;
        }
        load.m = table;
        const key = flag ? 3 : "4";
        load.m[key] = module => { module.exports = {}; };
        load(2);
      })();`;
      await writeFixtureFiles(root, { "main.cjs": source });
      const application = await analyzeJavaScriptDirectory(surface, cli, root);
      expect(application.summary).toMatchObject({ browser_windows: 1 });
      const windows = application.graph.nodes
        .filter(({ kind }) => kind === "browser-window")
        .flatMap(({ observations }) => observations);
      expect(windows).toContainEqual(
        expect.objectContaining({
          evidence: expect.objectContaining({
            state: "observed",
            artifact: expect.objectContaining({
              available: true,
              sha256: createHash("sha256").update(source).digest("hex"),
            }),
            location: expect.objectContaining({
              available: true,
              value: expect.objectContaining({
                source: "main.cjs",
                start: expect.objectContaining({ line: 6 }),
              }),
            }),
          }),
        }),
      );
    },
  );
}
