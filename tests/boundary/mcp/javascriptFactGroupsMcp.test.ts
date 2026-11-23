import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";

const preload = `const { contextBridge, ipcRenderer } = require("electron");
const dynamic = globalThis.channelName;
contextBridge.exposeInMainWorld("bridge", {
  ready: () => ipcRenderer.send("ready"),
  readyAgain: () => ipcRenderer.send("ready"),
  close: () => ipcRenderer.send("window-close"),
  info: () => ipcRenderer.invoke("get-info"),
  any: () => ipcRenderer.send(dynamic),
});`;

const main = `const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
ipcMain.on("ready", () => {});
ipcMain.handle("get-info", () => ({}));
app.whenReady().then(() => new BrowserWindow({
  webPreferences: { preload: path.join(__dirname, "preload.js") },
}));`;

const connect = async () => {
  const harness = await createApplicationMcpHarness({
    session: createTestBinarySession(() => {
      throw new Error("Reading retained facts must not start a deep provider");
    }),
  });
  onTestFinished(() => harness.close());
  return harness;
};

it("counts distinct retained IPC channels per operation and reads one group's observations", async () => {
  const root = await createTestTempDirectory("rea-js-fact-groups-");
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      '{"name":"fact-groups","main":"main.js"}',
    ),
    writeFile(join(root, "main.js"), main),
    writeFile(join(root, "preload.js"), preload),
  ]);
  const harness = await connect();
  const analyzed = await harness.client.callTool({
    name: "analyze_javascript_application",
    arguments: { input_path: root, detail: "summary" },
  });
  expect(analyzed.isError).not.toBe(true);
  const summary = analysisViewResultSchema.parse(
    parseEvidence(analyzed.structuredContent).normalized_result,
  );
  if (summary.kind !== "summary") throw new Error("Expected summary view");
  const source = {
    kind: "retained-evidence",
    evidence_id: summary.parent_evidence_id,
  };
  const [definition] = (await harness.client.listTools()).tools.filter(
    (tool) => tool.name === "inspect_analysis_view",
  );
  if (definition === undefined) throw new Error("Missing view tool");
  const { ajv, inputSchema } = await advertisedMcpToolSchemas(
    harness.client,
    "inspect_analysis_view",
  );
  const view = async (selected: unknown) => {
    expect(ajv.validate(inputSchema, { source, view: selected })).toBe(true);
    const wire = await harness.client.callTool(
      { name: "inspect_analysis_view", arguments: { source, view: selected } },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
    expect(wire.isError).not.toBe(true);
    return analysisViewResultSchema.parse(
      parseEvidence(wire.structuredContent).normalized_result,
    );
  };

  const where = { paths: ["preload.js"], kinds: ["ipc-channel"] };
  const groups = await view({
    kind: "javascript-fact-groups",
    where,
    group_by: ["operation", "channel"],
  });
  if (groups.kind !== "javascript-fact-groups")
    throw new Error("Expected fact groups");
  // The repeated send is one group with two observations; the dynamic channel
  // keeps its retained null rather than disappearing or merging.
  expect(groups.rows).toEqual([
    {
      properties: { operation: "invoke", channel: "get-info" },
      observation_count: 1,
      node_count: 1,
    },
    {
      properties: { operation: "send", channel: "ready" },
      observation_count: 2,
      node_count: 1,
    },
    {
      properties: { operation: "send", channel: "window-close" },
      observation_count: 1,
      node_count: 1,
    },
    {
      properties: { operation: "send", channel: null },
      observation_count: 1,
      node_count: 1,
    },
  ]);
  expect(groups.coverage).toMatchObject({ total: 4, exhausted: true });

  const sends = await view({
    kind: "javascript-fact-groups",
    where: {
      ...where,
      properties: [{ key: "operation", values: ["send"] }],
    },
    group_by: ["channel"],
    limit: 2,
  });
  if (sends.kind !== "javascript-fact-groups")
    throw new Error("Expected fact groups");
  expect(sends.rows.map((row) => row.properties)).toEqual([
    { channel: "ready" },
    { channel: "window-close" },
  ]);
  expect(sends.coverage).toMatchObject({
    examined: 2,
    total: 3,
    next_offset: 2,
  });

  // The same selector reads the grouped observations with provenance.
  const ready = await view({
    kind: "javascript-facts",
    where: {
      ...where,
      properties: [
        { key: "operation", values: ["send"] },
        { key: "channel", values: ["ready"] },
      ],
    },
    property_keys: ["channel"],
  });
  if (ready.kind !== "javascript-facts") throw new Error("Expected facts");
  expect(ready.rows).toHaveLength(2);
  for (const row of ready.rows) {
    expect(row.properties).toEqual({ channel: "ready" });
    expect(row.evidence.location).toMatchObject({
      available: true,
      value: { source: "preload.js" },
    });
  }

  // A missing key never matches, and empty values select nothing.
  for (const properties of [
    [{ key: "not_retained", values: [null] }],
    [{ key: "operation", values: [] }],
    [
      { key: "operation", values: ["send"] },
      { key: "operation", values: ["invoke"] },
    ],
  ]) {
    const none = await view({
      kind: "javascript-facts",
      where: { ...where, properties },
      property_keys: [],
    });
    if (none.kind !== "javascript-facts") throw new Error("Expected facts");
    expect(none.rows).toEqual([]);
    expect(none.coverage).toMatchObject({ total: 0 });
  }

  const rejected = await harness.client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source,
      view: { kind: "javascript-fact-groups", where, group_by: [] },
    },
  });
  expect(parseMcpToolError(rejected)).toMatchObject({
    error: {
      code: "invalid_request",
      details: {
        issues: [
          { path: ["view", "group_by"], reason: "out_of_range", minimum: 1 },
        ],
      },
    },
  });
});
