import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeElectronApiAliasApplication } from "../../fixtures/electronApiAliasApplication.js";

import {
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
} from "../../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  javascriptApplicationAnalysisResultSchema,
  type JavaScriptApplicationAnalysisResult,
} from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { parseJavaScriptApplicationGraph } from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { z } from "zod";

import { ELECTRON_IDENTITY_LIMITATION } from "../../../src/domain/javascript/javascriptElectronMemberWrites.js";

const execute = promisify(execFile);
const requireFixture = createRequire(import.meta.url);
// Analysis requests are stateless; retain one compiled server and its SDK
// validators while every scenario still owns a separate application directory.
const mcpTransport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("scripts/rea.mjs"), "mcp"],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
  stderr: "pipe",
});
mcpTransport.stderr?.on("data", () => undefined);
const mcpClient = new Client({
  name: "application-workflow-parity",
  version: "1",
});
let mcpConnection: Promise<void> | undefined;
const connectedMcpClient = async (): Promise<Client> => {
  await (mcpConnection ??= mcpClient.connect(mcpTransport));
  return mcpClient;
};

afterAll(async () => {
  try {
    await mcpClient.close();
  } finally {
    await mcpTransport.close();
  }
});
const WEBPACK_FACTORY_BODY = `
  const key = "dynamic";
  const __webpack_require__ = {
    d(target, definitions) {
      for (const name of Object.keys(definitions))
        Object.defineProperty(target, name, {
          enumerable: true,
          get: definitions[name],
        });
    },
  };
  exports[key] = 1;
  exports["dot.key"] = 2;
  exports[""] = 3;
  exports.nested = {};
  exports.nested.child = 6;
  exports["nested.child"] = 7;
  module.exports["module.dot"] = 5;
  module["exports.decoy"] = 99;
  Object.defineProperty(exports, "", {
    value: 4,
    configurable: true,
    enumerable: true,
  });
  __webpack_require__.d(exports, { "from.helper": () => 7 });
  exports = function ignored() { return 8; };
`;

const writeSelfImportFixture = async (root: string): Promise<void> => {
  await Promise.all([
    writeFile(
      join(root, "esm.js"),
      'import "./esm.js"; export const value = 1;\n',
    ),
    writeFile(
      join(root, "common.cjs"),
      'const self = require("./common.cjs"); module.exports = self;\n',
    ),
    writeFile(
      join(root, "util.ts"),
      'import "./util.ts"; export const value = 1;\n',
    ),
  ]);
};

const expectSelfImportEvidence = (
  graph: JavaScriptApplicationAnalysisResult["graph"],
): void => {
  const rawSelfImports = graph.edges.filter(
    ({ relation, properties, evidence }) =>
      relation === "imports" &&
      (properties.kind === "static-import" || properties.kind === "require") &&
      evidence.location.available &&
      evidence.location.value.kind === "source-range" &&
      ((properties.specifier === "./esm.js" &&
        properties.kind === "static-import" &&
        evidence.location.value.source === "esm.js") ||
        (properties.specifier === "./common.cjs" &&
          properties.kind === "require" &&
          evidence.location.value.source === "common.cjs") ||
        (properties.specifier === "./util.ts" &&
          properties.kind === "static-import" &&
          evidence.location.value.source === "util.ts")),
  );
  expect(rawSelfImports).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          kind: "static-import",
          specifier: "./esm.js",
        }),
        evidence: expect.objectContaining({
          authority: "static-relationship-inference",
          location: expect.objectContaining({
            available: true,
            value: expect.objectContaining({
              kind: "source-range",
              source: "esm.js",
              start: expect.objectContaining({ line: 1, column: 0 }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          kind: "require",
          specifier: "./common.cjs",
        }),
        evidence: expect.objectContaining({
          authority: "static-relationship-inference",
          location: expect.objectContaining({
            available: true,
            value: expect.objectContaining({
              kind: "source-range",
              source: "common.cjs",
              start: expect.objectContaining({ line: 1, column: 13 }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          kind: "static-import",
          specifier: "./util.ts",
        }),
        evidence: expect.objectContaining({
          authority: "static-relationship-inference",
          location: expect.objectContaining({
            available: true,
            value: expect.objectContaining({
              kind: "source-range",
              source: "util.ts",
              start: expect.objectContaining({ line: 1, column: 0 }),
            }),
          }),
        }),
      }),
    ]),
  );
  expect(rawSelfImports).toHaveLength(3);
};

const analyzeThroughStdioMcp = async (
  inputPath: string,
): Promise<JavaScriptApplicationAnalysisResult> => {
  const client = await connectedMcpClient();
  const response = await client.callTool({
    name: "analyze_javascript_application",
    arguments: { input_path: inputPath },
  });
  expect(response.isError).not.toBe(true);
  expect(response.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "text" })]),
  );
  const result = z
    .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
    .parse(response.structuredContent).normalized_result;
  expect(result).toMatchObject({
    input_path: inputPath,
    format: "directory",
  });
  return result;
};

const expectCliAnalysisParity = async (
  root: string,
  mcp: JavaScriptApplicationAnalysisResult,
): Promise<void> => {
  const cli = z
    .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
    .parse(
      await runCli(["analyze-javascript-application", root, "--json"]),
    ).normalized_result;
  expect(cli).toEqual(mcp);
};

describe("Electron alias identity through stdio MCP", () => {
  it.each([
    {
      name: "CommonJS binding chains",
      cliParity: true,
      esm: false,
      main: 'const { BrowserWindow, ipcMain } = require("electron"); const First = BrowserWindow; const Win = First; const ipc = ipcMain;',
      preload:
        'const { contextBridge, ipcRenderer } = require("electron"); const First = contextBridge; const bridge = First; const ipc = ipcRenderer;',
    },
    {
      name: "static namespace members",
      esm: false,
      main: 'const electron = require("electron"); const copied = electron; copied.unrelated = {}; const Win = copied["BrowserWindow"]; const ipc = copied.ipcMain;',
      preload:
        'const electron = require("electron"); const copied = electron; const bridge = copied.contextBridge; const ipc = copied["ipcRenderer"];',
    },
    {
      name: "namespace destructuring",
      esm: false,
      main: 'const electron = require("electron"); const { BrowserWindow: Win, ipcMain: ipc } = electron;',
      preload:
        'const electron = require("electron"); const { contextBridge: bridge, ipcRenderer: ipc } = electron;',
    },
    {
      name: "unwritten let and var bindings",
      esm: false,
      main: 'const { BrowserWindow, ipcMain } = require("electron"); let Win = BrowserWindow; var ipc = ipcMain;',
      preload:
        'const { contextBridge, ipcRenderer } = require("electron"); var bridge = contextBridge; let ipc = ipcRenderer;',
    },
    {
      name: "ESM binding aliases",
      cliParity: true,
      esm: true,
      main: 'import { BrowserWindow, ipcMain } from "electron"; const Win = BrowserWindow; const ipc = ipcMain;',
      preload:
        'import { contextBridge, ipcRenderer } from "electron"; const bridge = contextBridge; const ipc = ipcRenderer;',
    },
  ])(
    "recovers Electron boundaries through $name (#1656)",
    async ({ cliParity, main, preload, esm }) => {
      const root = await createTestTempDirectory("rea-electron-alias-cli-");
      await Promise.all([
        writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "alias-repro",
            version: "1.0.0",
            main: "main.js",
            type: esm ? "module" : "commonjs",
          }),
        ),
        writeFile(
          join(root, "main.js"),
          `${main}\n${esm ? 'import { fileURLToPath } from "node:url";' : 'const path = require("node:path");'}\nnew Win({ webPreferences: { preload: ${esm ? 'fileURLToPath(new URL("./preload.js", import.meta.url))' : 'path.join(__dirname, "preload.js")'} } });\nipc.handle("ch:ping", async () => "pong");\nfunction shadow(Win, ipc) { new Win(); ipc.handle("ch:decoy", () => null); }\n`,
        ),
        writeFile(
          join(root, "preload.js"),
          `${preload}\nbridge.exposeInMainWorld("api", { ping: () => ipc.invoke("ch:ping") });\nfunction shadow(bridge, ipc) { bridge.exposeInMainWorld("decoy", {}); ipc.invoke("ch:decoy"); }\n`,
        ),
      ]);
      const result = await analyzeThroughStdioMcp(root);
      // Keep CLI parity for both module formats; the other rows vary only AST
      // semantics already exercised by the same public analysis workflow.
      if (cliParity) await expectCliAnalysisParity(root, result);
      expect(result.summary).toMatchObject({
        browser_windows: 1,
        explicit_web_preferences: 1,
        preload_entrypoints: 1,
        context_bridge_apis: 1,
        exposed_api_members: 1,
        ipc: {
          operations: 2,
          literal_channels: 1,
          main_handlers: 1,
          renderer_transmissions: 1,
          paired_renderer_transmissions: 1,
        },
      });
      expect(result.limitations).toContain(ELECTRON_IDENTITY_LIMITATION);
      expect(result.graph.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "ipc-channel",
            observations: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  channel: "ch:ping",
                  operation: "handle",
                }),
                evidence: expect.objectContaining({
                  authority: "ast-static-analysis",
                  location: expect.objectContaining({
                    available: true,
                    value: expect.objectContaining({
                      kind: "source-range",
                      source: "main.js",
                    }),
                  }),
                }),
              }),
              expect.objectContaining({
                properties: expect.objectContaining({
                  channel: "ch:ping",
                  operation: "invoke",
                }),
                evidence: expect.objectContaining({
                  authority: "ast-static-analysis",
                  location: expect.objectContaining({
                    available: true,
                    value: expect.objectContaining({
                      kind: "source-range",
                      source: "preload.js",
                    }),
                  }),
                }),
              }),
            ]),
          }),
        ]),
      );
      expect(result.graph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relation: "handles" }),
          expect.objectContaining({ relation: "invokes" }),
          expect.objectContaining({ relation: "loads" }),
          expect.objectContaining({ relation: "exposes" }),
        ]),
      );
    },
  );
});

describe("Electron unavailable identity through stdio MCP", () => {
  it.each([
    {
      name: "reassigned aliases",
      cliParity: true,
      main: 'const { BrowserWindow, ipcMain } = require("electron"); let Win = BrowserWindow; let ipc = ipcMain; Win = class {}; ipc = { handle() {} };',
      preload:
        'const { contextBridge, ipcRenderer } = require("electron"); let bridge = contextBridge; let ipc = ipcRenderer; bridge = { exposeInMainWorld() {} }; ipc = { invoke() {} };',
    },
    {
      name: "conditional initializers",
      main: 'const { BrowserWindow, ipcMain } = require("electron"); if (enabled) { var Win = BrowserWindow; var ipc = ipcMain; }',
      preload:
        'const { contextBridge, ipcRenderer } = require("electron"); if (enabled) { var bridge = contextBridge; var ipc = ipcRenderer; }',
    },
    {
      name: "dynamic property selections",
      main: 'const electron = require("electron"); const Win = electron[windowKey]; const ipc = electron[ipcKey];',
      preload:
        'const electron = require("electron"); const bridge = electron[bridgeKey]; const ipc = electron[ipcKey];',
    },
    {
      name: "overwritten namespace exports",
      main: 'const electron = require("electron"); const copied = electron; copied.BrowserWindow = class {}; electron.ipcMain = { handle() {} }; const Win = electron.BrowserWindow; const ipc = copied.ipcMain;',
      preload:
        'const electron = require("electron"); electron.contextBridge = { exposeInMainWorld() {} }; electron.ipcRenderer = { invoke() {} }; const bridge = electron.contextBridge; const ipc = electron.ipcRenderer;',
    },
    {
      name: "overwritten API methods",
      main: 'const electron = require("electron"); const ipc = electron.ipcMain; ipc.handle = () => null; const Win = electron[windowKey];',
      preload:
        'const electron = require("electron"); const bridge = electron.contextBridge; delete bridge.exposeInMainWorld; const ipc = electron.ipcRenderer; ipc.invoke++;',
    },
    {
      name: "direct require namespace writes",
      main: 'require("electron").BrowserWindow = class {}; require("electron").ipcMain = {handle() {}}; const {BrowserWindow: Win, ipcMain: ipc} = require("electron");',
      preload:
        'require("electron").contextBridge = {}; require("electron").ipcRenderer = {}; const {contextBridge: bridge, ipcRenderer: ipc} = require("electron");',
    },
    {
      name: "unknown namespace write keys",
      main: 'const electron = require("electron"); electron[unknownKey] = {}; const {BrowserWindow: Win, ipcMain: ipc} = electron;',
      preload:
        'const electron = require("electron"); electron[unknownKey] = {}; const {contextBridge: bridge, ipcRenderer: ipc} = electron;',
    },
    {
      name: "destructuring assignment targets",
      main: 'const electron = require("electron"); ({ BrowserWindow: electron.BrowserWindow, ipcMain: electron.ipcMain } = replacement); const {BrowserWindow: Win, ipcMain: ipc} = electron;',
      preload:
        'const electron = require("electron"); [electron.contextBridge, electron.ipcRenderer] = replacements; const {contextBridge: bridge, ipcRenderer: ipc} = electron;',
    },
    {
      name: "loop assignment targets",
      main: 'const electron = require("electron"); for ({ BrowserWindow: electron.BrowserWindow, ipcMain: electron.ipcMain } of replacements) {} const {BrowserWindow: Win, ipcMain: ipc} = electron;',
      preload:
        'const electron = require("electron"); for (electron.contextBridge in replacements) {} for (electron.ipcRenderer of replacements) {} const {contextBridge: bridge, ipcRenderer: ipc} = electron;',
    },
    {
      name: "literal keys containing dots",
      main: 'const electron = require("electron"); const Win = electron["fake.BrowserWindow"]; const ipc = electron["fake.ipcMain"]; electron["ipcMain.handle"]("ch:literal", () => null);',
      preload:
        'const electron = require("electron"); const bridge = electron["fake.contextBridge"]; const ipc = electron["fake.ipcRenderer"];',
    },
  ])(
    "keeps Electron identity unresolved for $name (#1656)",
    async ({ cliParity, main, preload }) => {
      const root = await createTestTempDirectory("rea-electron-alias-unknown-");
      await Promise.all([
        writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "alias-unknown",
            version: "1.0.0",
            main: "main.js",
          }),
        ),
        writeFile(
          join(root, "main.js"),
          `${main}\nnew Win(); ipc.handle("ch:ping", () => "pong");\n`,
        ),
        writeFile(
          join(root, "preload.js"),
          `${preload}\nbridge.exposeInMainWorld("api", { ping: () => ipc.invoke("ch:ping") });\n`,
        ),
      ]);
      const result = await analyzeThroughStdioMcp(root);
      if (cliParity) await expectCliAnalysisParity(root, result);
      expect(result.summary).toMatchObject({
        browser_windows: 0,
        context_bridge_apis: 0,
        ipc: { operations: 0 },
      });
      expect(
        result.graph.nodes.some(({ kind }) => kind === "ipc-channel"),
      ).toBe(false);
      expect(result.limitations).toContain(ELECTRON_IDENTITY_LIMITATION);
    },
  );
});

it("preserves complete line-comment source-map URLs through CLI and MCP", async () => {
  const root = await createTestTempDirectory("rea-source-map-url-cli-");
  const directives = [
    "//# sourceMappingURL=app.js.map?variant=a*modern",
    "//@ sourceMappingURL=app.js.map?variant=a*legacy",
    "//# sourceMappingURL=app.js.map#first*section",
  ];
  await writeFile(
    join(root, "app.js"),
    ["export const value = 1;", ...directives, ""].join("\n"),
  );
  await writeFile(
    join(root, "app.js.map"),
    JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }),
  );
  const { graph } = z
    .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
    .parse(
      await runCli(["analyze-javascript-application", root, "--json"]),
    ).normalized_result;
  const map = graph.nodes.find(
    ({ kind, observations }) =>
      kind === "source-map" &&
      observations.some(({ properties }) => properties.path === "app.js.map"),
  );
  const references = map?.observations.filter(
    ({ label }) => label === "source map reference",
  );
  expect(references).toHaveLength(directives.length);
  for (const [index, directive] of directives.entries()) {
    const declaredUrl = directive.slice(directive.indexOf("=") + 1);
    const digest = createHash("sha256").update(declaredUrl).digest("hex");
    expect(references).toContainEqual(
      expect.objectContaining({
        properties: {
          declared_url: declaredUrl,
          declared_url_sha256: digest,
          resolved_path: "app.js.map",
          available: true,
        },
        evidence: expect.objectContaining({
          location: {
            available: true,
            value: {
              kind: "source-range",
              source: "app.js",
              start: { line: index + 2, column: 0 },
              end: { line: index + 2, column: directive.length },
            },
          },
        }),
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "maps_to",
        target_node_id: map?.node_id,
        properties: {
          declared_url_sha256: digest,
          resolved_path: "app.js.map",
        },
      }),
    );
  }
  expect((await analyzeThroughStdioMcp(root)).graph).toEqual(graph);
}, 20_000);

it("resolves source-map URL paths once without changing their declarations", async () => {
  const root = await createTestTempDirectory("rea-source-map-encoding-cli-");
  const cases = [
    ["space%20part.js.map", "space part.js.map"],
    ["literal%25.js.map", "literal%.js.map"],
    ["encoded%2520.js.map", "encoded%20.js.map"],
    ["space%20part.js.map?v=1#section", "space part.js.map"],
    ["caf%C3%A9.js.map", "café.js.map"],
    ["literal%ZZ.js.map", "literal%ZZ.js.map"],
  ] as const;
  for (const path of new Set(cases.map(([, path]) => path))) {
    await writeFile(
      join(root, path),
      JSON.stringify({
        version: 3,
        file: path,
        sources: [],
        names: [],
        mappings: "",
      }),
    );
  }
  await writeFile(
    join(root, "app.js"),
    cases.map(([url]) => `//# sourceMappingURL=${url}\n`).join("") +
      'new Worker("./worker%20file.js");\n' +
      'navigator.serviceWorker.register("./service%20worker.js");\n',
  );
  await writeFile(join(root, "worker file.js"), "export const worker = 1;\n");
  await writeFile(
    join(root, "service worker.js"),
    "export const service = 2;\n",
  );
  const { graph } = z
    .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
    .parse(
      await runCli(["analyze-javascript-application", root, "--json"]),
    ).normalized_result;
  for (const [index, [declaredUrl, path]] of cases.entries()) {
    const map = graph.nodes.find(
      ({ kind, observations }) =>
        kind === "source-map" &&
        observations.some(({ properties }) => properties.path === path),
    );
    const digest = createHash("sha256").update(declaredUrl).digest("hex");
    expect(map?.observations).toContainEqual(
      expect.objectContaining({
        properties: {
          declared_url: declaredUrl,
          declared_url_sha256: digest,
          resolved_path: path,
          available: true,
        },
        evidence: expect.objectContaining({
          location: {
            available: true,
            value: {
              kind: "source-range",
              source: "app.js",
              start: { line: index + 1, column: 0 },
              end: {
                line: index + 1,
                column: "//# sourceMappingURL=".length + declaredUrl.length,
              },
            },
          },
        }),
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "maps_to",
        target_node_id: map?.node_id,
        properties: { declared_url_sha256: digest, resolved_path: path },
      }),
    );
  }
  for (const [kind, specifier, path] of [
    ["worker", "./worker%20file.js", "worker file.js"],
    ["service-worker", "./service%20worker.js", "service worker.js"],
  ]) {
    const worker = graph.nodes.find((node) => node.kind === kind);
    expect(worker?.observations).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          declared_specifier: specifier,
          resolved_path: path,
        }),
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source_node_id: worker?.node_id,
        relation: "maps_to",
        properties: { resolved_path: path },
      }),
    );
  }
  expect((await analyzeThroughStdioMcp(root)).graph).toEqual(graph);
}, 20_000);

describe("JavaScript application path CLI", () => {
  it("accepts a relative local application path and preserves canonical Evidence identity", async () => {
    const root = await createTestTempDirectory("rea-relative-application-cli-");
    await writeFile(join(root, "app.js"), "export const value = 1;\n");
    const absolute = await analyzeJavaScriptApplication({ input_path: root });
    if (!absolute.ok) throw absolute.error;
    const absoluteAnalysis = javascriptApplicationAnalysisResultSchema.parse(
      absolute.value.normalized_result,
    );

    const relativePath = relative(process.cwd(), root);
    const fromCli = await runCli([
      "analyze-javascript-application",
      relativePath,
      "--json",
    ]);

    expect(fromCli).toMatchObject({
      evidence_id: absolute.value.evidence_id,
      normalized_result: {
        input_path: absoluteAnalysis.input_path,
      },
      subject: { local_path: absolute.value.subject?.local_path },
    });
  }, 20_000);

  it("returns the self-import graph consistently through CLI and stdio MCP", async () => {
    const root = await createTestTempDirectory(
      "rea-self-import-application-cli-",
    );
    await writeSelfImportFixture(root);

    const analyzed = await runCli([
      "analyze-javascript-application",
      root,
      "--json",
    ]);
    const result = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(analyzed);
    const graph = result.normalized_result.graph;
    expectSelfImportEvidence(graph);
    const mcpResult = await analyzeThroughStdioMcp(root);
    expect(mcpResult.graph).toEqual(graph);
    expect(mcpResult.semantic_graph).toEqual(
      result.normalized_result.semantic_graph,
    );
  }, 20_000);

  it("preserves canonical Electron API aliases through CLI and stdio MCP", async () => {
    const root = await createTestTempDirectory("rea-electron-api-alias-");
    await writeElectronApiAliasApplication(root);

    const cliResult = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(
        await runCli(["analyze-javascript-application", root, "--json"]),
      ).normalized_result;
    expect(cliResult.summary).toMatchObject({
      browser_windows: 1,
      explicit_web_preferences: 1,
      preload_entrypoints: 1,
      context_bridge_apis: 1,
      exposed_api_members: 1,
      ipc: {
        operations: 2,
        literal_channels: 1,
        main_handlers: 1,
        renderer_transmissions: 1,
        paired_renderer_transmissions: 1,
        unpaired_literal_renderer_transmissions: 0,
      },
    });
    const graph = parseJavaScriptApplicationGraph(cliResult.graph);
    const window = graph.nodes.find(({ kind }) => kind === "browser-window");
    expect(window?.observations[0]?.evidence.location).toMatchObject({
      available: true,
      value: {
        kind: "source-range",
        source: "main.cjs",
        start: { line: 6 },
      },
    });
    const bridge = graph.nodes.find(
      ({ kind }) => kind === "context-bridge-api",
    );
    expect(bridge?.observations[0]?.evidence.location).toMatchObject({
      available: true,
      value: {
        kind: "source-range",
        source: "preload.cjs",
        start: { line: 5 },
      },
    });

    const mcpResult = await analyzeThroughStdioMcp(root);
    expect(mcpResult.summary).toEqual(cliResult.summary);
    expect(mcpResult.graph).toEqual(cliResult.graph);
    expect(mcpResult.semantic_graph).toEqual(cliResult.semantic_graph);
  }, 20_000);
});

describe("application workflow CLI parity", () => {
  it("accepts inline trace JSON and file-backed comparison JSON", async () => {
    const traced = await runCli([
      "trace-application-feature",
      JSON.stringify(JAVASCRIPT_FEATURE_TRACE_EXAMPLE),
      "--json",
    ]);
    expect(traced).toMatchObject({
      operation: "trace_application_feature",
      predicate_type: "rea.application-feature-trace",
      normalized_result: {
        seed: { kind: "module", value: "renderer.js", match: "exact" },
        summary: {
          matched_seeds: 1,
          traced_nodes: 1,
          traced_edges: 0,
          terminal_paths: 0,
          native_handoffs: 0,
          observed_facts: 1,
          inferred_facts: 0,
          unknown_facts: 0,
          unavailable_facts: 0,
        },
        coverage: {
          status: "complete-within-source",
          source_graph_status: "complete",
          total_seed_matches: 1,
        },
      },
    });

    const root = await createTestTempDirectory("rea-application-cli-");
    const comparisonPath = join(root, "comparison.json");
    await writeFile(
      comparisonPath,
      JSON.stringify(JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE),
    );
    const compared = await runCli([
      "compare-application-versions",
      comparisonPath,
      "--json",
    ]);
    expect(compared).toMatchObject({
      operation: "compare_application_versions",
      predicate_type: "rea.application-version-comparison",
      normalized_result: {
        summary: {
          unchanged: 0,
          added: 2,
          removed: 0,
          changed: 1,
          unknown: 0,
        },
        coverage: {
          left_graph_status: "complete",
          right_graph_status: "complete",
          left_graph_omitted_count: 0,
          right_graph_omitted_count: 0,
          status: "complete-within-inputs",
        },
      },
    });
    const sourceCompared = await runCli([
      "compare-source-to-bundle",
      JSON.stringify({
        reference: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference,
        application: JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application,
      }),
      "--json",
    ]);
    expect(sourceCompared).toMatchObject({
      operation: "compare_source_to_bundle",
      predicate_type: "rea.source-to-bundle-comparison",
      normalized_result: {
        reference: { inventory_state: "complete" },
        summary: {
          unchanged: 0,
          modified: 0,
          removed: 1,
          split: 0,
          merged: 0,
          duplicated: 0,
          unknown: 0,
        },
        coverage: {
          status: "complete-within-inputs",
          reference_inventory_state: "complete",
          application_graph_status: "complete",
          retained_source_files: 1,
          retained_application_nodes: 1,
        },
      },
    });
  }, 20_000);

  it("traces the same authenticated semantic graph through the CLI", async () => {
    const root = await createTestTempDirectory("rea-semantic-cli-");
    await writeFile(
      join(root, "app.js"),
      "function add(value) { return value + 1; } add(2);",
    );
    const analyzed = await analyzeJavaScriptApplication({
      input_path: root,
    });
    if (!analyzed.ok) throw analyzed.error;
    const result = javascriptApplicationAnalysisResultSchema.parse(
      analyzed.value.normalized_result,
    );
    const seed = result.semantic_graph.relations[0]?.source_node_id;
    if (seed === undefined)
      throw new TypeError("Expected at least one semantic relation");

    const traced = await runCli([
      "trace-javascript-semantics",
      JSON.stringify({
        application: analyzed.value,
        query: {
          seed: { kind: "semantic-node", node_id: seed },
          direction: "forward-influence",
          include_ambiguous_dynamic_edges: true,
        },
      }),
      "--json",
    ]);
    expect(traced).toMatchObject({
      operation: "trace_javascript_semantics",
      predicate_type: "rea.javascript-semantic-trace",
      normalized_result: {
        source_evidence_id: analyzed.value.evidence_id,
        source_graph_id: result.semantic_graph.graph_id,
      },
    });
  }, 20_000);
});

describe("rest parameter semantic trace CLI", () => {
  it("traces each ordinary rest argument to its parameter through public application Evidence", async () => {
    const root = await createTestTempDirectory("rea-rest-arguments-cli-");
    await writeFile(
      join(root, "app.js"),
      "function collect(first, ...rest) { return rest; } collect('first', 'second', 'third');",
    );
    const application = await runCli([
      "analyze-javascript-application",
      root,
      "--json",
    ]);
    const graph = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(application).normalized_result.semantic_graph;
    for (const index of [1, 2]) {
      const argument = graph.nodes.find(
        ({ kind, label }) =>
          kind === "expression" && label === `argument ${String(index)}`,
      );
      if (argument === undefined) throw new Error("Missing argument node");
      const traced = await runCli([
        "trace-javascript-semantics",
        JSON.stringify({
          application,
          query: {
            seed: { kind: "semantic-node", node_id: argument.node_id },
            direction: "forward-influence",
            allowed_relations: ["argument-to-parameter"],
            expected: { role: "sink", classes: ["parameter"] },
          },
        }),
        "--json",
      ]);
      expect(traced).toMatchObject({
        normalized_result: {
          status: "found",
          nodes: expect.arrayContaining([
            expect.objectContaining({ kind: "parameter", label: "rest" }),
          ]),
        },
      });
    }
  }, 20_000);
});

describe("empty property key application CLI", () => {
  it.each(["const root = routes[''];", "const {'': root} = routes;"])(
    "analyzes a root-route dictionary with %s",
    async (read) => {
      const root = await createTestTempDirectory("rea-empty-key-cli-");
      await writeFile(
        join(root, "app.js"),
        `const routes = {'': 'HOME'}; ${read}`,
      );
      const evidence = await runCli([
        "analyze-javascript-application",
        root,
        "--json",
      ]);
      expect(evidence).toMatchObject({
        operation: "analyze_javascript_application",
        normalized_result: {
          semantic_graph: {
            nodes: expect.arrayContaining([
              expect.objectContaining({
                kind: "property-slot",
                label: '""',
                properties: expect.objectContaining({ name: "" }),
              }),
            ]),
          },
        },
      });
    },
    20_000,
  );
});

describe("Webpack factory CommonJS export keys", () => {
  it("keeps exact static keys and omits computed names through CLI and MCP", async () => {
    const root = await createTestTempDirectory("rea-webpack-export-keys-");
    const bundle = `globalThis.webpackChunkStaticExports.push([["main"], {
      1: function(module, exports, __webpack_require__) {${WEBPACK_FACTORY_BODY}},
      2: function(module) { module.exports = function realDefault() {}; },
      3: function(module, exports) { exports = function ignoredDefault() {}; },
      4: function(module) {
        const key = "dynamic";
        module.exports = { [key]: 1, stable: 2 };
      },
      5: function(module) { module.exports = { __proto__: {} }; },
      6: function(module) {
        module.exports = { ["__proto__"]: 1, __proto__() {} };
      }
    }]);`;
    await writeFile(join(root, "bundle.js"), bundle);

    // Execute the same factory body as CommonJS, outside the analyzer, to
    // verify Node's alias behavior and the exact runtime object keys.
    const oracleRoot = await createTestTempDirectory(
      "rea-webpack-export-oracle-",
    );
    const oraclePath = join(oracleRoot, "oracle.cjs");
    await writeFile(oraclePath, WEBPACK_FACTORY_BODY);
    const actual = requireFixture(oraclePath) as Record<string, unknown>;
    expect(Reflect.ownKeys(actual).sort()).toEqual([
      "",
      "dot.key",
      "dynamic",
      "from.helper",
      "module.dot",
      "nested",
      "nested.child",
    ]);
    expect(actual).toMatchObject({
      "": 4,
      "dot.key": 2,
      dynamic: 1,
      "from.helper": 7,
      "module.dot": 5,
      nested: { child: 6 },
      "nested.child": 7,
    });
    const prototypeSetterPath = join(oracleRoot, "prototype-setter.cjs");
    const ownPrototypeKeyPath = join(oracleRoot, "own-prototype-key.cjs");
    await Promise.all([
      writeFile(prototypeSetterPath, "module.exports = { __proto__: {} }"),
      writeFile(
        ownPrototypeKeyPath,
        'module.exports = { ["__proto__"]: 1, __proto__() {} }',
      ),
    ]);
    expect(
      Reflect.ownKeys(requireFixture(prototypeSetterPath) as object),
    ).toEqual([]);
    expect(
      Reflect.ownKeys(requireFixture(ownPrototypeKeyPath) as object),
    ).toEqual(["__proto__"]);

    const aliasPath = join(oracleRoot, "alias.cjs");
    const replacementPath = join(oracleRoot, "replacement.cjs");
    await Promise.all([
      writeFile(aliasPath, "exports = function ignored() {};"),
      writeFile(
        replacementPath,
        "module.exports = function actual() { return 42; };",
      ),
    ]);
    expect(requireFixture(aliasPath)).toEqual({});
    const replacement: unknown = requireFixture(replacementPath);
    if (typeof replacement !== "function")
      throw new Error("Expected Node to load the replacement export");
    expect(replacement()).toBe(42);

    const applicationEvidenceSchema = z.object({
      evidence_id: z.string(),
      normalized_result: javascriptApplicationAnalysisResultSchema,
    });
    const cliEvidence = applicationEvidenceSchema.parse(
      await runCli([
        "analyze-javascript-application",
        root,
        "--artifact-format",
        "directory",
        "--json",
      ]),
    );
    const client = await connectedMcpClient();
    const response = await client.callTool({
      name: "analyze_javascript_application",
      arguments: { input_path: root, format: "directory" },
    });
    expect(response.isError).not.toBe(true);
    const mcpEvidence = applicationEvidenceSchema.parse(
      response.structuredContent,
    );
    expect(await client.ping()).toEqual({});
    expect(mcpEvidence.evidence_id).toBe(cliEvidence.evidence_id);

    const expectBundleExports = (
      evidence: typeof cliEvidence,
      moduleKey: string,
      expected: readonly string[],
    ) => {
      const module = evidence.normalized_result.graph.nodes.find(
        ({ kind, observations }) =>
          kind === "javascript-module" &&
          observations.some(
            ({ properties }) =>
              properties.runtime === "webpackChunkStaticExports" &&
              properties.module_key === moduleKey,
          ),
      );
      if (module === undefined)
        throw new Error(`Missing webpack factory ${moduleKey}`);
      expect(module.observations[0]?.properties.exports).toEqual(expected);
    };
    for (const evidence of [cliEvidence, mcpEvidence]) {
      expectBundleExports(evidence, "1", [
        "",
        "dot.key",
        "from.helper",
        "module.dot",
        "nested",
        "nested.child",
      ]);
      expectBundleExports(evidence, "2", ["default"]);
      expectBundleExports(evidence, "3", []);
      expectBundleExports(evidence, "4", ["stable"]);
      expectBundleExports(evidence, "5", []);
      expectBundleExports(evidence, "6", ["__proto__"]);
    }
  }, 20_000);
});

describe("application workflow CLI input", () => {
  it("rejects Evidence ID-only workflow inputs", async () => {
    const result = await runCli([
      "compare-application-versions",
      JSON.stringify({
        left: JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE.left
          .evidence_id,
        right:
          JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE.right.evidence_id,
      }),
      "--json",
    ]);
    expect(result).toMatchObject({ code: "invalid_request" });
  });
});

describe("application workflow CLI copy boundaries", () => {
  it("compares source values excluded from escaped rest and spread copies", async () => {
    const root = await createTestTempDirectory("rea-copy-boundary-cli-");
    const sources = [
      `export default function make() {
        function mutate(value) { value.changed = true; }
        const objectRest = { only: { value: "TOKEN" } };
        const { only, ...restObject } = objectRest;
        mutate(restObject);
        const arrayRest = [{ value: "TOKEN" }];
        const [head, ...restArray] = arrayRest;
        mutate(restArray);
        const objectSpread = { child: { value: "TOKEN" } };
        const spreadObject = { ...objectSpread, child: {} };
        mutate(spreadObject.child);
        const arraySpread = [{ value: "TOKEN" }];
        const spreadArray = [{}, ...arraySpread];
        mutate(spreadArray[0]);
        return {
          kind: "copy-boundary",
          objectRest: objectRest.only.value,
          arrayRest: arrayRest[0].value,
          objectSpread: objectSpread.child.value,
          arraySpread: arraySpread[0].value,
        };
      }`,
      `export default function make() {
        return {
          kind: "copy-boundary",
          objectRest: "UPDATED", arrayRest: "UPDATED",
          objectSpread: "UPDATED", arraySpread: "UPDATED",
        };
      }`,
    ];
    const [left, right] = await analyzeComparisonSources(root, sources);
    const inputPath = join(root, "comparison.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        left,
        right,
        left_module_path: "parser.mjs",
        left_export_name: "default",
        right_module_path: "parser.mjs",
        right_export_name: "default",
      }),
    );
    const compared = await runCli([
      "compare-javascript-export-shapes",
      inputPath,
      "--json",
    ]);
    expect(compared).toMatchObject({
      normalized_result: {
        summary: { added: 0, removed: 0, changed: 4, unknown: 0 },
        coverage: { status: "complete-within-inputs" },
        changes: expect.arrayContaining(
          ["/arrayRest", "/arraySpread", "/objectRest", "/objectSpread"].map(
            (path) =>
              expect.objectContaining({
                status: "changed",
                path,
                left: { availability: "literal", value: "TOKEN" },
                right: { availability: "literal", value: "UPDATED" },
              }),
          ),
        ),
      },
    });
  }, 20_000);
});

describe("application workflow CLI and MCP capture lifetimes", () => {
  it("compares captured primitives and source values after aliases are replaced", async () => {
    const root = await createTestTempDirectory("rea-capture-lifetime-cli-");
    const fields = [
      "rebound",
      "rest",
      "snapshot",
      "destructured",
      "objectSnapshot",
      "arraySnapshot",
      "unusedFallback",
      "nestedSnapshot",
      "declaratorSnapshot",
    ];
    const sources = [
      `export default function make() {
        function mutate(value) { value.value = "MUTATED"; }
        const original = {value: "TOKEN"};
        let alias = original;
        alias = {};
        mutate(alias);
        const child = {value: "TOKEN"};
        let {...rest} = {child};
        rest = {child: {}};
        rest.child.value = "MUTATED";
        const source = {value: "TOKEN"};
        const snapshot = source.value;
        const {value: destructured} = source;
        const objectSnapshot = {value: source.value};
        const arraySnapshot = [source.value];
        mutate(source);
        const fallback = {value: "TOKEN"};
        const container = {child: {}};
        const {child: selected = fallback} = container;
        mutate(selected);
        const nestedSource = {value: "TOKEN"};
        const nestedSnapshot = nestedSource.value;
        const ignored = mutate(nestedSource);
        const declaratorSource = {value: "TOKEN"},
          declaratorSnapshot = declaratorSource.value,
          declaratorIgnored = mutate(declaratorSource);
        return {
          kind: "capture-boundary",
          rebound: original.value, rest: child.value,
          snapshot, destructured,
          objectSnapshot: objectSnapshot.value, arraySnapshot: arraySnapshot[0],
          unusedFallback: fallback.value, nestedSnapshot, declaratorSnapshot,
        };
      }`,
      `export default function make() { return ${JSON.stringify({
        kind: "capture-boundary",
        ...Object.fromEntries(fields.map((field) => [field, "UPDATED"])),
      })}; }`,
    ];
    // Retain a complete CLI analysis-to-comparison journey alongside MCP parity.
    const [left, right] = await Promise.all(
      (await writeComparisonSources(root, sources)).map((applicationRoot) =>
        runCli(["analyze-javascript-application", applicationRoot, "--json"]),
      ),
    );
    // Execute the authored fixtures independently of static analysis.
    for (const [index, value] of ["TOKEN", "UPDATED"].entries()) {
      const { stdout } = await execute(process.execPath, [
        "--input-type=module",
        "--eval",
        "const module = await import(process.argv[1]); console.log(JSON.stringify(module.default()));",
        join(root, String(index), "parser.mjs"),
      ]);
      expect(JSON.parse(stdout)).toEqual({
        kind: "capture-boundary",
        ...Object.fromEntries(fields.map((field) => [field, value])),
      });
    }
    const input = {
      left,
      right,
      left_module_path: "parser.mjs",
      left_export_name: "default",
      right_module_path: "parser.mjs",
      right_export_name: "default",
    };
    const inputPath = join(root, "comparison.json");
    await writeFile(inputPath, JSON.stringify(input));
    const expected = {
      normalized_result: {
        summary: { added: 0, removed: 0, changed: fields.length, unknown: 0 },
        coverage: { status: "complete-within-inputs" },
        changes: expect.arrayContaining(
          fields.map((field) =>
            expect.objectContaining({
              path: `/${field}`,
              status: "changed",
              left: { availability: "literal", value: "TOKEN" },
              right: { availability: "literal", value: "UPDATED" },
            }),
          ),
        ),
      },
    };
    expect(
      await runCli(["compare-javascript-export-shapes", inputPath, "--json"]),
    ).toMatchObject(expected);
    expect(await compareThroughStdioMcp(input)).toMatchObject(expected);
  }, 20_000);
});

describe("application workflow CLI export Evidence", () => {
  it("preserves uncertainty after a helper can mutate an awaited return object", async () => {
    const root = await createTestTempDirectory("rea-awaited-export-shape-cli-");
    const sources = [
      `export default async function make() {
        const result = { kind: "record" };
        function mutate(value) { value.extra = 1; }
        mutate(await result);
        return result;
      }`,
      'export default async function make() { return { kind: "record", extra: 1 }; }',
    ];
    const [left, right] = await analyzeComparisonSources(root, sources);
    const compared = await runCli([
      "compare-javascript-export-shapes",
      JSON.stringify({
        left,
        right,
        left_module_path: "parser.mjs",
        left_export_name: "default",
        right_module_path: "parser.mjs",
        right_export_name: "default",
      }),
      "--json",
    ]);
    expect(compared).toMatchObject({
      operation: "compare_javascript_export_shapes",
      normalized_result: {
        summary: { added: 0, removed: 0, changed: 0 },
        coverage: { status: "partial" },
        changes: expect.arrayContaining([
          expect.objectContaining({ status: "unknown" }),
        ]),
      },
    });
  }, 20_000);

  it("compares exact export shapes from file-backed Evidence", async () => {
    const root = await createTestTempDirectory("rea-export-shape-cli-");
    const leftRoot = join(root, "left");
    const rightRoot = join(root, "right");
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
    await Promise.all([
      copyFile(
        join(process.cwd(), "tests/fixtures/replay/parser.mjs"),
        join(leftRoot, "parser.mjs"),
      ),
      copyFile(
        join(process.cwd(), "tests/fixtures/replay/parser-v2.mjs"),
        join(rightRoot, "parser.mjs"),
      ),
    ]);
    const [left, right] = await Promise.all([
      analyzeJavaScriptApplication({
        input_path: leftRoot,
      }),
      analyzeJavaScriptApplication({
        input_path: rightRoot,
      }),
    ]);
    if (!left.ok) throw left.error;
    if (!right.ok) throw right.error;
    const inputPath = join(root, "comparison.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        left: left.value,
        right: right.value,
        left_module_path: "parser.mjs",
        left_export_name: "default",
        right_module_path: "parser.mjs",
        right_export_name: "default",
      }),
    );
    const compared = await runCli([
      "compare-javascript-export-shapes",
      inputPath,
      "--json",
    ]);
    expect(compared).toMatchObject({
      operation: "compare_javascript_export_shapes",
      predicate_type: "rea.javascript-export-shape-comparison",
      normalized_result: {
        summary: { added: 1, removed: 0, changed: 0, unknown: 0 },
        changes: [
          {
            status: "added",
            path: "/depth",
            presence: { left: "absent", right: "present" },
            right: { availability: "literal", value: 1 },
          },
        ],
      },
    });
  }, 20_000);
});

describe("application workflow CLI export property presence", () => {
  it("reports tagged search property presence through compare-javascript-export-shapes", async () => {
    const root = await createTestTempDirectory(
      "rea-export-shape-presence-cli-",
    );
    const leftRoot = join(root, "left");
    const rightRoot = join(root, "right");
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
    await Promise.all([
      writeFile(
        join(leftRoot, "search.js"),
        [
          "export function search(items, q) {",
          "  const matches = items.filter((item) => item.includes(q));",
          '  return { kind: "results", matches, count: matches.length };',
          "}",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(rightRoot, "search.js"),
        [
          "export function search(items, q) {",
          "  const matches = items.filter((item) => item.includes(q));",
          '  return { kind: "results", matches, total: matches.length, query: String(q) };',
          "}",
          "",
        ].join("\n"),
      ),
    ]);
    const [left, right] = await Promise.all([
      analyzeJavaScriptApplication({ input_path: leftRoot }),
      analyzeJavaScriptApplication({ input_path: rightRoot }),
    ]);
    if (!left.ok) throw left.error;
    if (!right.ok) throw right.error;
    const inputPath = join(root, "comparison.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        left: left.value,
        right: right.value,
        left_module_path: "search.js",
        left_export_name: "search",
        right_module_path: "search.js",
        right_export_name: "search",
      }),
    );
    const compared = await runCli([
      "compare-javascript-export-shapes",
      inputPath,
      "--json",
    ]);
    expect(compared).toMatchObject({
      operation: "compare_javascript_export_shapes",
      normalized_result: {
        summary: { added: 2, removed: 1 },
        property_inventories: expect.arrayContaining([
          expect.objectContaining({
            side: "left",
            paired: true,
            properties: expect.arrayContaining(["/count", "/kind", "/matches"]),
          }),
          expect.objectContaining({
            side: "right",
            paired: true,
            properties: expect.arrayContaining([
              "/kind",
              "/matches",
              "/query",
              "/total",
            ]),
          }),
        ]),
        changes: expect.arrayContaining([
          expect.objectContaining({
            status: "removed",
            path: "/count",
            presence: { left: "present", right: "absent" },
          }),
          expect.objectContaining({
            status: "added",
            path: "/total",
            presence: { left: "absent", right: "present" },
          }),
          expect.objectContaining({
            status: "added",
            path: "/query",
            presence: { left: "absent", right: "present" },
          }),
        ]),
      },
    });
  }, 20_000);
});

describe("application workflow CLI validation", () => {
  it("returns safe actionable JSON validation details", async () => {
    const malformed = await runCli([
      "trace-application-feature",
      "{not-json",
      "--json",
    ]);
    expect(malformed).toMatchObject({
      code: "invalid_request",
      retryable: true,
      details: {
        issues: [{ path: [], reason: "invalid_format", expected: "JSON" }],
      },
    });
    expect(JSON.stringify(malformed)).not.toContain("not-json");

    const missing = await runCli(["trace-application-feature", "{}", "--json"]);
    expect(missing).toMatchObject({
      code: "invalid_request",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["seed"],
            reason: "missing_argument",
          }),
        ]),
      },
    });
  }, 20_000);
});

const compareThroughStdioMcp = async (
  input: Record<string, unknown>,
): Promise<unknown> => {
  const client = await connectedMcpClient();
  const response = await client.callTool({
    name: "compare_javascript_export_shapes",
    arguments: input,
  });
  expect(response.isError).not.toBe(true);
  return response.structuredContent;
};

const writeComparisonSources = (
  root: string,
  sources: readonly string[],
): Promise<string[]> =>
  Promise.all(
    sources.map(async (source, index) => {
      const applicationRoot = join(root, String(index));
      await mkdir(applicationRoot);
      await writeFile(join(applicationRoot, "parser.mjs"), source);
      return applicationRoot;
    }),
  );

// Produce comparison inputs through the shared stateless stdio workflow;
// each consumer still executes the real CLI with its own authored sources.
const analyzeComparisonSources = async (
  root: string,
  sources: readonly string[],
): Promise<unknown[]> => {
  const client = await connectedMcpClient();
  return Promise.all(
    (await writeComparisonSources(root, sources)).map(
      async (applicationRoot) => {
        const response = await client.callTool({
          name: "analyze_javascript_application",
          arguments: { input_path: applicationRoot },
        });
        expect(response.isError).not.toBe(true);
        return response.structuredContent;
      },
    ),
  );
};

it("retains bundled isolated-world contextBridge APIs through dedicated and generic CLI routes", async () => {
  const root = await createTestTempDirectory(
    "rea-context-bridge-isolated-cli-",
  );
  await writeFile(
    join(root, "preload.js"),
    `(() => {
      const modules = {
        2(module) { module.exports = require("electron"); },
        5(module, exports, load) {
          const electron = load(2);
          electron.contextBridge.exposeInIsolatedWorld(1001, "isolatedApi", { ping: true });
        },
      };
      function load(id) {
        const module = { exports: {} };
        modules[id].call(module.exports, module, module.exports, load);
        return module.exports;
      }
      load(5);
    })();`,
  );

  for (const arguments_ of [
    ["analyze-javascript-application", root, "--json"],
    ["analyze", root, "--format", "json"],
  ]) {
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(await runCli(arguments_)).normalized_result,
    );
    expect(result.summary.context_bridge_apis).toBe(1);
    const bridge = result.graph.nodes.find(
      ({ kind }) => kind === "context-bridge-api",
    );
    expect(bridge?.observations).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          world: "isolated",
          world_id: { status: "literal", value: 1001, expression: null },
          api_key: "isolatedApi",
          members: ["ping"],
          resolution_basis: "wrapper-substitution",
        }),
        evidence: expect.objectContaining({
          location: expect.objectContaining({
            available: true,
            value: expect.objectContaining({ source: "preload.js" }),
          }),
        }),
      }),
    );
  }
});

const runCli = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...environment },
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    return JSON.parse(stdout);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return JSON.parse(cause.stdout);
    throw cause;
  }
};
