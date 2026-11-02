import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves hoisted Electron initialization uncertainty through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-electron-initialization-");
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ main: "early.cjs" }),
      "early.cjs": `
        const { BrowserWindow } = require("electron");
        createWindow();
        const webPreferences = { nodeIntegration: true };
        function createWindow() {
          return new BrowserWindow({ webPreferences });
        }
        require("./late.cjs");
        require("./early-loop.cjs");
        require("./late-loop.cjs");
        throw new Error("must not execute source");
      `,
      "late.cjs": `
        const { BrowserWindow } = require("electron");
        function createWindow() {
          return new BrowserWindow({ webPreferences });
        }
        const webPreferences = { nodeIntegration: true };
        createWindow();
        throw new Error("must not execute source");
      `,
      "early-loop.cjs": `
        const { BrowserWindow } = require("electron");
        createWindow();
        const webPreferences = { nodeIntegration: true };
        function createWindow() {
          for (const item of [0]) return new BrowserWindow({ webPreferences });
        }
        throw new Error("must not execute source");
      `,
      "late-loop.cjs": `
        const { BrowserWindow } = require("electron");
        const webPreferences = { nodeIntegration: true };
        function createWindow() {
          for (const item of [0]) return new BrowserWindow({ webPreferences });
        }
        createWindow();
        throw new Error("must not execute source");
      `,
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    const windows = result.graph.nodes.filter(
      ({ kind }) => kind === "browser-window",
    );
    expect(windows).toHaveLength(4);
    const observations = windows.flatMap(({ observations }) => observations);
    const inSource = (source: string) =>
      observations.filter(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === source,
      );
    for (const source of ["early.cjs", "early-loop.cjs"]) {
      expect(inSource(source)).toHaveLength(1);
      expect(inSource(source)[0]?.properties).toMatchObject({
        web_preferences_status: "dynamic",
        web_preferences: [],
      });
    }
    for (const source of ["late.cjs", "late-loop.cjs"]) {
      expect(inSource(source)).toHaveLength(1);
      expect(inSource(source)[0]?.properties).toMatchObject({
        web_preferences_status: "object-literal",
        web_preferences: [
          {
            name: "nodeIntegration",
            value: { status: "literal", value: true },
          },
        ],
      });
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves classic global initialization uncertainty through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory(
      "rea-electron-global-initialization-",
    );
    const source = (early: boolean) => `
      const { BrowserWindow } = require("electron");
      ${early ? "globalThis.createWindow();" : ""}
      const webPreferences = { nodeIntegration: true };
      function createWindow() { return new BrowserWindow({ webPreferences }); }
      ${early ? "" : "globalThis.createWindow();"}
      createWindow();
      throw new Error("must not execute source");
    `;
    await writeFixtureFiles(root, {
      "early.js": source(true),
      "late.js": source(false),
      "index.html":
        '<script src="early.js"></script><script src="late.js"></script>',
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    const windows = result.graph.nodes.filter(
      ({ kind }) => kind === "browser-window",
    );
    expect(windows).toHaveLength(2);
    const inSource = (name: string) =>
      windows
        .flatMap(({ observations }) => observations)
        .filter(
          ({ evidence }) =>
            evidence.location.available &&
            evidence.location.value.kind === "source-range" &&
            evidence.location.value.source === name,
        );
    expect(inSource("early.js")).toHaveLength(1);
    expect(inSource("early.js")[0]?.properties).toMatchObject({
      web_preferences_status: "dynamic",
      web_preferences: [],
    });
    expect(inSource("late.js")).toHaveLength(1);
    expect(inSource("late.js")[0]?.properties).toMatchObject({
      web_preferences_status: "object-literal",
      web_preferences: [
        { name: "nodeIntegration", value: { status: "literal", value: true } },
      ],
    });
  },
);
