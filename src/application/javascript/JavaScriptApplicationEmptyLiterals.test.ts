import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import { matchJavaScriptApplicationVersions } from "../../domain/javascript/javascriptApplicationVersionKeys.js";
import { findApplicationFeatureSeeds } from "../../domain/javascript/javascriptFeatureSeed.js";
import { traceApplicationFeatureInputSchema } from "../../domain/javascript/javascriptFeatureTraceSchemas.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

const analyzeSource = async (
  source: string,
  extraFiles: Readonly<Record<string, string>> = {},
) => {
  const inputPath = await createTestTempDirectory("rea-js-empty-literal-");
  await writeFile(join(inputPath, "app.js"), `${source}\n`);
  for (const [path, text] of Object.entries(extraFiles))
    await writeFile(join(inputPath, path), text);
  const result = await analyzeJavaScriptApplication({
    input_path: inputPath,
    format: "directory",
  });
  if (!result.ok)
    throw new Error(`Expected analysis success: ${result.error.message}`);
  return javascriptApplicationAnalysisResultSchema.parse(
    result.value.normalized_result,
  );
};

it.each([
  "fetch('');",
  "new WebSocket('');",
  "navigator.serviceWorker.register('');",
  "new Worker('');",
  "const x = require('');",
  "import y from ''; y();",
  "import('');",
  "localStorage.getItem('');",
  "localStorage.setItem('', 1);",
  "indexedDB.open('');",
  "win.loadFile('');",
  "win.loadURL('');",
  "app.get('', handler);",
  "process.on('', () => 1);",
  "const { EventEmitter } = require('events'); new EventEmitter().on('', () => 1);",
  "const { spawn } = require('child_process'); spawn('/bin/x').on('', () => 1);",
  "const { ipcMain } = require('electron'); ipcMain.handle('', () => 1);",
  "const { ipcRenderer } = require('electron'); ipcRenderer.invoke('');",
  "const { contextBridge } = require('electron'); contextBridge.exposeInMainWorld('', {});",
])("analyzes the legal empty string literal in %s", async (source) => {
  await expect(analyzeSource(source)).resolves.toBeDefined();
});

it("analyzes a plain long-line loader without package metadata", async () => {
  const output = await analyzeSource(
    `var Module = {}; fetch(""); new Worker(""); var payload = "${"x".repeat(65_536)}";`,
    { "game-data.js": "Module.data = { ready: true };" },
  );
  const nodes = output.graph.nodes.filter(
    ({ kind }) => kind === "endpoint" || kind === "worker",
  );
  expect(nodes.map(({ kind }) => kind).sort()).toEqual(["endpoint", "worker"]);
  for (const node of nodes) {
    expect(node.identity).toMatchObject({
      strategy: "artifact-local-key",
      key: "",
    });
    expect(node.observations.map(({ label }) => label)).toEqual([null]);
  }
});

it("keeps exact values for empty literals without synthetic application labels", async () => {
  const output = await analyzeSource(
    "fetch(''); fetch('\"\"'); fetch('/api'); process.on('', () => 1);",
  );
  const endpoints = output.graph.nodes
    .filter(({ kind }) => kind === "endpoint")
    .map(({ identity, observations }) => ({
      key: identity.strategy === "artifact-local-key" ? identity.key : null,
      labels: observations.map(({ label }) => label),
      values: observations.map(({ properties }) => properties.value),
    }));
  // The empty endpoint has no display label, so it cannot be confused with
  // a literal two-quote endpoint; both keep exact identities.
  expect(endpoints).toEqual(
    expect.arrayContaining([
      { key: "", labels: [null], values: [""] },
      { key: '""', labels: ['""'], values: ['""'] },
      { key: "/api", labels: ["/api"], values: ["/api"] },
    ]),
  );
  expect(endpoints).toHaveLength(3);
  expect(
    output.semantic_graph?.nodes
      .filter(({ kind }) => kind === "event")
      .map(({ label, properties }) => ({
        label,
        eventName: properties.event_name,
      })),
  ).toEqual([{ label: '""', eventName: "" }]);
});

it.each([
  { version: 3, sources: [""], names: [], mappings: "AAAA" },
  {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: { version: 3, sources: [""], names: [], mappings: "AAAA" },
      },
    ],
  },
])("projects an empty source-map source name: %j", async (map) => {
  const output = await analyzeSource("//# sourceMappingURL=app.js.map", {
    "app.js.map": JSON.stringify(map),
  });
  const originals = output.graph.nodes
    .filter(({ kind }) => kind === "source-module")
    .map(({ identity, observations }) => ({
      originalSource:
        identity.strategy === "source-map-original"
          ? identity.original_source
          : null,
      sources: observations.map(({ properties }) => properties.source),
    }));
  expect(originals).toEqual([{ originalSource: "", sources: [""] }]);
});

it("keeps empty and two-quote source-map names distinct", async () => {
  const output = await analyzeSource("//# sourceMappingURL=app.js.map", {
    "app.js.map": JSON.stringify({
      version: 3,
      sources: ["", '""'],
      names: [],
      mappings: "AAAA,CCAA",
    }),
  });
  expect(
    output.graph.nodes
      .filter(({ kind }) => kind === "source-module")
      .map(({ identity }) =>
        identity.strategy === "source-map-original"
          ? identity.original_source
          : null,
      )
      .sort(),
  ).toEqual(["", '""']);
});

it("does not match an empty endpoint with a literal two-quote seed", async () => {
  const output = await analyzeSource("fetch(''); fetch('\"\"');");
  const endpoints = new Map(
    output.graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .map((node) => [
        node.node_id,
        node.identity.strategy === "artifact-local-key"
          ? node.identity.key
          : null,
      ]),
  );
  const matches = findApplicationFeatureSeeds(output.graph.nodes, {
    kind: "string",
    value: '""',
    match: "exact",
    case_sensitive: true,
  }).filter(({ node_id: nodeId }) => endpoints.has(nodeId));
  expect(matches.map(({ node_id: nodeId }) => endpoints.get(nodeId))).toEqual([
    '""',
  ]);
});

const IPC_SOURCE =
  "const { ipcMain } = require('electron'); ipcMain.handle('', () => 1); ipcMain.handle('\"\"', () => 2);";

const ipcChannels = (
  nodes: Awaited<ReturnType<typeof analyzeSource>>["graph"]["nodes"],
) =>
  new Map(
    nodes
      .filter(({ kind }) => kind === "ipc-channel")
      .map((node) => [node.node_id, node.observations[0]?.properties.channel]),
  );

it("selects an empty IPC channel with an exact empty seed", async () => {
  const output = await analyzeSource(IPC_SOURCE);
  const channels = ipcChannels(output.graph.nodes);
  const matches = findApplicationFeatureSeeds(output.graph.nodes, {
    kind: "channel",
    value: "",
    match: "exact",
    case_sensitive: true,
  });
  expect(matches.map(({ node_id: nodeId }) => channels.get(nodeId))).toEqual([
    "",
  ]);
});

const seedSchema = traceApplicationFeatureInputSchema.shape.seed;
const validateAdvertisedSeed = new Ajv2020({
  strict: false,
  validateFormats: false,
}).compile(z.toJSONSchema(seedSchema, { io: "input" }));

it.each([
  [{ kind: "channel", value: "", match: "exact" }, true],
  [{ kind: "string", value: "", match: "exact" }, true],
  [{ kind: "channel", value: "/x" }, true],
  [{ kind: "string", value: "" }, false],
  [{ kind: "channel", value: "" }, false],
  [{ kind: "channel", value: "", match: "contains" }, false],
  [{ kind: "node-id", value: "", match: "exact" }, false],
] as const)(
  "validates empty seed %j at runtime and in the advertised schema",
  (seed, accepted) => {
    expect(seedSchema.safeParse(seed).success).toBe(accepted);
    expect(validateAdvertisedSeed(seed)).toBe(accepted);
  },
);

it("pairs the same empty IPC channel across application versions", async () => {
  const left = await analyzeSource(IPC_SOURCE);
  const right = await analyzeSource(`${IPC_SOURCE} // v2`);
  const leftChannels = ipcChannels(left.graph.nodes);
  const rightChannels = ipcChannels(right.graph.nodes);
  const matching = matchJavaScriptApplicationVersions(
    left.graph.nodes,
    right.graph.nodes,
  );
  expect(
    matching.pairs
      .filter(({ left: node }) => node.kind === "ipc-channel")
      .map(({ left: leftNode, right: rightNode }) => [
        leftChannels.get(leftNode.node_id),
        rightChannels.get(rightNode.node_id),
      ]),
  ).toEqual(
    expect.arrayContaining([
      ["", ""],
      ['""', '""'],
    ]),
  );
  expect(matching.unmatchedLeft.map(({ kind }) => kind)).not.toContain(
    "ipc-channel",
  );
});

it("selects an empty context-bridge API with an exact empty seed", async () => {
  const output = await analyzeSource(
    "const { contextBridge } = require('electron'); contextBridge.exposeInMainWorld('', {}); contextBridge.exposeInMainWorld('\"\"', {});",
  );
  const apis = new Map(
    output.graph.nodes
      .filter(({ kind }) => kind === "context-bridge-api")
      .map((node) => [node.node_id, node.observations[0]?.properties.api_key]),
  );
  const matches = findApplicationFeatureSeeds(output.graph.nodes, {
    kind: "api",
    value: "",
    match: "exact",
    case_sensitive: true,
  });
  expect(matches.map(({ node_id: nodeId }) => apis.get(nodeId))).toEqual([""]);
});
