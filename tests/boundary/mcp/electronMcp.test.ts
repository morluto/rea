import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type { ElectronActiveObservationPort } from "../../../src/application/javascript/ElectronActiveObservationPort.js";
import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import { writeElectronBoundaryFixture } from "../../fixtures/electronBoundaryApplication.js";
import { createElectronActiveObservationFixtureResult } from "../../../src/domain/javascript/electronActiveObservation.fixture.js";

const browsers: FakeCdpBrowser[] = [];
const resources: Array<{ close(): Promise<unknown> }> = [];
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async (item) => item.close()));
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

it("exposes endpoint-scoped Electron discovery and inspection as Evidence", async () => {
  const root = await createTestTempDirectory("rea-electron-mcp-");
  temporary.push(root);
  await writeFile(join(root, "index.html"), "<script src='app.js'></script>");
  await writeFile(
    join(root, "app.js"),
    "export const observed = 'source-secret';",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "runtime-fixture", renderer: "index.html" }),
  );
  await writeFile(join(root, "worker.js"), "self.onmessage = () => {};\n");
  const browser = await startFakeCdpBrowser({
    electronFileUrl: pathToFileURL(join(root, "index.html")).href,
    commandEvents: ({ method }) =>
      method === "Debugger.enable"
        ? [
            {
              method: "Debugger.scriptParsed",
              sessionId: "session-1",
              params: {
                scriptId: "partial-script",
                url: pathToFileURL(join(root, "app.js")).href,
                executionContextId: 1,
              },
            },
          ]
        : undefined,
  });
  browsers.push(browser);
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer(session, session, {
    electronObservation: new CdpElectronProvider(),
    availabilityPolicy: () => ({
      processCaptureEnabled: false,
      investigationInputRoots: 1,
    }),
  });
  const client = new Client({ name: "electron-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.callTool({
    name: "list_electron_targets",
    arguments: {
      cdp_endpoint: browser.endpoint,
    },
  });
  expect(listed.isError).not.toBe(true);
  expect(listed.structuredContent).toMatchObject({
    normalized_result: {
      targets: [{ target_id: "electron-page" }],
    },
  });
  const inspected = await client.callTool({
    name: "inspect_electron_page",
    arguments: {
      cdp_endpoint: browser.endpoint,
      target_id: "electron-page",
      observation_ms: 0,
      include_script_sources: true,
    },
  });
  const analyzed = await client.callTool({
    name: "analyze_javascript_application",
    arguments: { input_path: root },
  });
  expect(analyzed.isError).not.toBe(true);
  expect(analyzed.structuredContent).toMatchObject({
    normalized_result: {
      graph: { nodes: expect.any(Array), edges: expect.any(Array) },
    },
  });
  const analysisText = analyzed.content.find(({ type }) => type === "text");
  expect(analysisText).toBeDefined();
  if (analysisText?.type !== "text")
    throw new TypeError("Missing JavaScript analysis text projection");
  expect(analysisText.text).toContain('"nodes":[');
  const reconciled = await client.callTool({
    name: "reconcile_javascript_runtime",
    arguments: {
      static_layers: [
        {
          role: "application",
          analysis: evidenceFor(analyzed.structuredContent),
        },
      ],
      runtime_observations: [evidenceFor(inspected.structuredContent)],
    },
  });
  expect(reconciled.isError).not.toBe(true);
  expect(reconciled.structuredContent).toMatchObject({
    normalized_result: {
      summary: { runtime_scripts: 1, matched: expect.any(Number) },
      source_map_authority: { used_for_primary_matching: false },
    },
  });
  expect(inspected.isError).not.toBe(true);
  expect(inspected.structuredContent).toMatchObject({
    normalized_result: {
      target: { file_path: expect.stringMatching(/\/index\.html$/u) },
      scripts: {
        items: [
          expect.objectContaining({
            frame_id: "frame-main",
            file_path: expect.stringMatching(/\/app\.js$/u),
            cdp_hash: null,
            length: null,
            is_module: null,
          }),
        ],
      },
      workers: [
        expect.objectContaining({
          target_id: "electron-worker",
          opener_target_id: "electron-page",
          file_path: expect.stringMatching(/\/worker\.js$/u),
        }),
      ],
    },
  });
}, 20_000);

it("runs active Electron scenarios with selected paths and inferred working directory", async () => {
  const root = await createTestTempDirectory("rea-electron-active-mcp-");
  temporary.push(root);
  const applicationPath = join(root, "main.js");
  await writeFile(applicationPath, "module.exports = {};\n");
  const aliasedRoot = join(root, "..", `${root.split("/").at(-1)}-alias`);
  await symlink(root, aliasedRoot, "dir");
  temporary.push(aliasedRoot);
  const workingDirectory = await createTestTempDirectory(
    "rea-electron-working-directory-",
  );
  temporary.push(workingDirectory);
  const capturedInputs: unknown[] = [];
  const activeResult =
    createElectronActiveObservationFixtureResult(applicationPath);
  const provider: ElectronActiveObservationPort = {
    identity: () => ({
      id: "test-electron-active",
      name: "Test Electron active provider",
      version: "1",
    }),
    capture: async (input) => {
      capturedInputs.push(input);
      return { ok: true, value: activeResult };
    },
  };
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer(session, session, {
    electronActiveObservation: provider,
    availabilityPolicy: () => ({
      processCaptureEnabled: false,
      investigationInputRoots: 0,
    }),
  });
  const client = new Client({ name: "electron-active-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const captured = await client.callTool({
    name: "capture_electron_scenario",
    arguments: {
      executable_path: process.execPath,
      application_path: join(aliasedRoot, "main.js"),
      application_root: workingDirectory,
      args: ["--token", "super-secret"],
      actions: [
        { step_id: "submit", kind: "click", selector: "#submit-secret" },
      ],
    },
  });
  expect(captured.isError, JSON.stringify(captured)).not.toBe(true);
  expect(captured.structuredContent).toMatchObject({
    normalized_result: {
      application: { process_ownership: "provider-owned" },
      ipc: { events: [{ channel: "readiness:echo" }] },
      coverage: {
        status: "partial_attach",
        pre_capture_activity: "unavailable",
      },
    },
  });
  expect(capturedInputs).toHaveLength(1);
  expect(capturedInputs[0]).toMatchObject({
    application_path: applicationPath,
    application_root: workingDirectory,
  });
  const inferredRoot = await client.callTool({
    name: "capture_electron_scenario",
    arguments: {
      executable_path: process.execPath,
      application_path: applicationPath,
      actions: [],
    },
  });
  expect(inferredRoot.isError, JSON.stringify(inferredRoot)).not.toBe(true);
  expect(capturedInputs[1]).toMatchObject({
    application_path: applicationPath,
    application_root: root,
  });
  expect(JSON.stringify(captured.structuredContent)).toContain("submit-secret");
  expect(JSON.stringify(captured.structuredContent)).toContain("super-secret");
  expect(captured.structuredContent).toMatchObject({
    predicate_type: "rea.electron-active-scenario",
    operation: "capture_electron_scenario",
    parameters: {
      args: ["--token", "super-secret"],
      actions: [
        {
          step_id: "submit",
          kind: "click",
          selector: "#submit-secret",
          window_index: 0,
        },
      ],
    },
  });
}, 20_000);

it("exposes the target-free static JavaScript application workflow", async () => {
  const root = await createTestTempDirectory("rea-electron-static-mcp-");
  temporary.push(root);
  await writeElectronBoundaryFixture(root);
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer(session, session, {
    availabilityPolicy: () => ({
      processCaptureEnabled: false,
      investigationInputRoots: 1,
    }),
  });
  const client = new Client({
    name: "electron-static-mcp-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const progress: number[] = [];
  const analyzed = await client.callTool(
    {
      name: "analyze_javascript_application",
      arguments: { input_path: root },
    },
    { onprogress: (update) => progress.push(update.progress) },
  );

  expect(analyzed.isError).not.toBe(true);
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(1);
  const projected = z
    .object({
      evidence_id: z.string(),
      normalized_result: z.object({
        input_path: z.string(),
        summary: z.object({
          browser_windows: z.number(),
          context_bridge_apis: z.number(),
          ipc: z.object({ paired_renderer_transmissions: z.number() }),
        }),
        graph: z.object({
          graph_id: z.string(),
          nodes: z.array(z.unknown()),
          edges: z.array(z.unknown()),
        }),
        semantic_graph: z.object({
          graph_id: z.string(),
          nodes: z.array(z.unknown()),
          relations: z.array(z.unknown()),
        }),
      }),
      operation: z.literal("analyze_javascript_application"),
      parameters: z.object({ format: z.string() }),
    })
    .parse(analyzed.structuredContent);
  expect(projected.normalized_result).toMatchObject({
    input_path: expect.stringMatching(/rea-electron-static-mcp-/u),
    summary: {
      browser_windows: 3,
      context_bridge_apis: 2,
      ipc: { paired_renderer_transmissions: 4 },
    },
  });
  expect(projected.normalized_result.graph.nodes.length).toBeGreaterThan(0);
  expect(
    projected.normalized_result.semantic_graph.nodes.length,
  ).toBeGreaterThan(0);
  expect(projected.operation).toBe("analyze_javascript_application");
  const direct = await analyzeJavaScriptApplication({ input_path: root });
  if (!direct.ok) throw direct.error;
  expect(projected.evidence_id).toBe(direct.value.evidence_id);
});

const evidenceFor = (value: unknown) => {
  return parseEvidence(value);
};
