import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const MAIN = [
  'const path = require("node:path");',
  'const { BrowserWindow, utilityProcess } = require("electron");',
  'const PRELOAD = path.join(__dirname, "preload.js");',
  'const SERVICE = path.join(__dirname, "service.js");',
  'const PAGE = path.join(__dirname, "page.html");',
  'let RUNTIME_PRELOAD = path.join(__dirname, "runtime.js");',
  "new BrowserWindow({ webPreferences: { preload: PRELOAD } }).loadFile(PAGE);",
  "new BrowserWindow({ webPreferences: { preload: RUNTIME_PRELOAD } });",
  "new BrowserWindow({ webPreferences: { preload: EARLY_PRELOAD } });",
  'const EARLY_PRELOAD = path.join(__dirname, "early.js");',
  "utilityProcess.fork(SERVICE);",
];
const INERT = "throw new Error('Static fixture must never execute');\n";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "links constant Electron paths through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-electron-constant-paths-");
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ main: "main.cjs" }),
      "main.cjs": `${MAIN.join("\n")}\n`,
      "preload.js": INERT,
      "runtime.js": INERT,
      "early.js": INERT,
      "service.js": INERT,
      "page.html": "<!doctype html><title>page</title>\n",
    });
    const { graph, statistics } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    expect(statistics.parse_failures).toBe(0);

    const preloads = graph.nodes
      .filter(({ kind }) => kind === "browser-window")
      .map((window) => {
        const [observation] = window.observations;
        const location = observation?.evidence.location;
        const association = graph.edges.find(
          ({ source_node_id, evidence }) =>
            source_node_id === window.node_id &&
            evidence.extractor.operation === "associate-browser-window-preload",
        );
        return {
          line:
            location?.available === true &&
            location.value.kind === "source-range"
              ? location.value.start.line
              : null,
          preload_path: observation?.properties.preload_path,
          resolved_path: association?.properties.resolved_path ?? null,
        };
      })
      .sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
    // Mutable and possibly uninitialized bindings keep their expressions.
    expect(preloads).toEqual([
      { line: 7, preload_path: "preload.js", resolved_path: "preload.js" },
      { line: 8, preload_path: null, resolved_path: null },
      { line: 9, preload_path: null, resolved_path: null },
    ]);
    const runtimeWindow = graph.nodes.find(
      ({ kind, observations }) =>
        kind === "browser-window" &&
        observations[0]?.evidence.location.available === true &&
        observations[0].evidence.location.value.kind === "source-range" &&
        observations[0].evidence.location.value.start.line === 8,
    );
    expect(runtimeWindow?.observations[0]?.properties.web_preferences).toEqual([
      {
        name: "preload",
        value: {
          status: "dynamic",
          value: null,
          expression: "RUNTIME_PRELOAD",
        },
      },
    ]);

    expect(
      graph.nodes
        .filter(({ kind }) => kind === "electron-renderer")
        .flatMap(({ observations }) =>
          observations.map(({ properties }) => properties.resolved_path),
        ),
    ).toEqual(["page.html"]);
    expect(
      graph.nodes
        .filter(({ kind }) => kind === "electron-utility")
        .map(({ observations }) =>
          observations.map(({ properties }) => properties),
        ),
    ).toEqual([
      [
        expect.objectContaining({
          module_path: "service.js",
          module_resolution_context: "filesystem-expression",
          module_expression: null,
        }),
        expect.objectContaining({
          resolved_path: "service.js",
          resolution_status: "resolved",
        }),
      ],
    ]);
  },
);
