import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { BinarySession } from "../src/application/BinarySession.js";
import { loadConfiguredPermissionAuthority } from "../src/application/PermissionConfiguration.js";
import { CdpElectronProvider } from "../src/browser/CdpElectronProvider.js";
import { parseConfig } from "../src/config.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "./fixtures/fakeCdpBrowser.js";
import { writeElectronBoundaryFixture } from "./fixtures/electronBoundaryApplication.js";

describe("Electron MCP tools", () => {
  const browsers: FakeCdpBrowser[] = [];
  const resources: Array<{ close(): Promise<unknown> }> = [];
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map(async (item) => item.close()));
    await Promise.all(
      browsers.splice(0).map(async (browser) => browser.close()),
    );
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("exposes root-confined Electron discovery and inspection as Evidence v2", async () => {
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
    });
    browsers.push(browser);
    const config = parseConfig({
      REA_ELECTRON_OBSERVE_ENABLED: "true",
      REA_ELECTRON_CDP_ENDPOINTS_JSON: JSON.stringify([browser.endpoint]),
      REA_ELECTRON_FILE_ROOTS_JSON: JSON.stringify([root]),
      REA_INVESTIGATION_INPUT_ROOTS_JSON: JSON.stringify([root]),
    });
    if (!config.ok) throw config.error;
    const authority = await loadConfiguredPermissionAuthority(config.value);
    if (!authority.ok) throw authority.error;
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session, {
      electronObservation: new CdpElectronProvider(),
      permissionAuthority: authority.value,
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
        evidenceFileRoots: 0,
        investigationInputRoots: 1,
        electronObservationEnabled: true,
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
        allowed_file_roots: [root],
        approved: true,
      },
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      result: {
        targets: { items: [{ target_id: "electron-page" }] },
      },
    });
    const inspected = await client.callTool({
      name: "inspect_electron_page",
      arguments: {
        cdp_endpoint: browser.endpoint,
        allowed_file_roots: [root],
        target_id: "electron-page",
        approved: true,
        observation_ms: 0,
        include_script_sources: true,
        source_capture_approved: true,
      },
    });
    const analyzed = await client.callTool({
      name: "analyze_javascript_application",
      arguments: { input_path: root, approved: true, detail: "full" },
    });
    expect(analyzed.isError).not.toBe(true);
    expect(analyzed.structuredContent).toMatchObject({
      result: { graph: { nodes: expect.any(Array), edges: expect.any(Array) } },
    });
    const analysisText = analyzed.content.find(({ type }) => type === "text");
    expect(analysisText).toBeDefined();
    if (analysisText?.type !== "text")
      throw new TypeError("Missing JavaScript analysis text projection");
    expect(analysisText.text).not.toContain('"nodes":[');
    const reconciled = await client.callTool({
      name: "reconcile_javascript_runtime",
      arguments: {
        static_layers: [
          {
            role: "application",
            analysis: evidenceFor(session, analyzed.structuredContent),
          },
        ],
        runtime_observations: [
          evidenceFor(session, inspected.structuredContent),
        ],
      },
    });
    expect(reconciled.isError).not.toBe(true);
    expect(reconciled.structuredContent).toMatchObject({
      result: {
        summary: { runtime_scripts: 1, matched: expect.any(Number) },
        source_map_authority: { used_for_primary_matching: false },
      },
    });
    expect(inspected.isError).not.toBe(true);
    expect(inspected.structuredContent).toMatchObject({
      result: {
        target: { file_path: expect.stringMatching(/\/index\.html$/u) },
        scripts: {
          items: [
            expect.objectContaining({
              frame_id: "frame-main",
              file_path: expect.stringMatching(/\/app\.js$/u),
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
    const outside = join(root, "..", `outside-${Date.now().toString(16)}`);
    await mkdir(outside);
    temporary.push(outside);
    const commandsBeforeDenial = browser.commands.length;
    const denied = await client.callTool({
      name: "list_electron_targets",
      arguments: {
        cdp_endpoint: browser.endpoint,
        allowed_file_roots: [outside],
        approved: true,
      },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: {
        code: "permission_required",
        details: { missing: { roots: [expect.stringMatching(/outside-/u)] } },
      },
    });
    expect(browser.commands).toHaveLength(commandsBeforeDenial);
  });

  it("exposes the target-free static JavaScript application workflow", async () => {
    const root = await createTestTempDirectory("rea-electron-static-mcp-");
    temporary.push(root);
    await writeElectronBoundaryFixture(root);
    const config = parseConfig({
      REA_INVESTIGATION_INPUT_ROOTS_JSON: JSON.stringify([root]),
    });
    if (!config.ok) throw config.error;
    const authority = await loadConfiguredPermissionAuthority(config.value);
    if (!authority.ok) throw authority.error;
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session, {
      permissionAuthority: authority.value,
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
        evidenceFileRoots: 0,
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

    const analyzed = await client.callTool({
      name: "analyze_javascript_application",
      arguments: { input_path: root, approved: true },
    });

    expect(analyzed.isError).not.toBe(true);
    const projected = z
      .object({
        evidence_id: z.string(),
        result: z.object({
          schema_version: z.literal(1),
          input_path: z.string(),
          unknowns: z.array(z.string()),
          summary: z.object({
            browser_windows: z.number(),
            context_bridge_apis: z.number(),
            ipc: z.object({ paired_renderer_transmissions: z.number() }),
          }),
          graph: z.object({
            graph_id: z.string(),
            node_count: z.number(),
            edge_count: z.number(),
            top_findings: z.array(z.unknown()),
            pages: z.object({ nodes: z.string(), edges: z.string() }),
          }),
        }),
      })
      .parse(analyzed.structuredContent);
    expect(projected.result).toMatchObject({
      input_path: expect.stringMatching(/rea-electron-static-mcp-/u),
      summary: {
        browser_windows: 3,
        context_bridge_apis: 2,
        ipc: { paired_renderer_transmissions: 4 },
      },
    });
    expect(projected.result.graph.node_count).toBeGreaterThan(0);
    expect(JSON.stringify(analyzed.structuredContent)).not.toContain(
      '"nodes":[',
    );

    const nodePage = await client.readResource({
      uri: projected.result.graph.pages.nodes,
    });
    const nodeContent = nodePage.contents[0];
    if (nodeContent === undefined || !("text" in nodeContent))
      throw new TypeError("Missing JavaScript application graph node page");
    expect(JSON.parse(nodeContent.text)).toMatchObject({
      evidence_id: projected.evidence_id,
      graph_id: projected.result.graph.graph_id,
      collection: "nodes",
      items: expect.any(Array),
      offset: 0,
      limit: 100,
    });
  });

  it("reports an unconfigured investigation ceiling before static analysis", async () => {
    const root = await createTestTempDirectory("rea-electron-denied-mcp-");
    temporary.push(root);
    await writeElectronBoundaryFixture(root);
    const config = parseConfig({});
    if (!config.ok) throw config.error;
    const authority = await loadConfiguredPermissionAuthority(config.value);
    if (!authority.ok) throw authority.error;
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session, {
      permissionAuthority: authority.value,
    });
    const client = new Client({
      name: "electron-denied-mcp-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(client, server, session);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const status = await client.callTool({
      name: "binary_session",
      arguments: {
        detail: "capabilities",
        capability_family: "electron-provider",
        limit: 100,
      },
    });
    expect(status.structuredContent).toMatchObject({
      result: {
        capabilities: {
          items: expect.arrayContaining([
            expect.objectContaining({
              name: "analyze_javascript_application",
              available: false,
              reason: "policy_disabled",
            }),
            expect.objectContaining({
              name: "reconcile_javascript_runtime",
              available: true,
              reason: "available",
            }),
          ]),
        },
      },
    });

    const denied = await client.callTool({
      name: "analyze_javascript_application",
      arguments: { input_path: root, approved: true },
    });
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "permission_required",
          remediation: {
            action: expect.stringContaining("administrator configuration"),
            elicitation_supported: false,
            restart_required: true,
          },
          details: {
            capability: "investigation_input",
            missing: { roots: [root] },
            ceiling: expect.objectContaining({ roots: [] }),
          },
        },
      },
    });
  });

  const evidenceFor = (session: BinarySession, value: unknown) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("evidence_id" in value) ||
      typeof value.evidence_id !== "string"
    )
      throw new TypeError("Missing compact Evidence ID");
    const evidence = session.evidenceById(value.evidence_id);
    if (evidence === undefined) throw new TypeError("Missing session Evidence");
    return evidence;
  };
});
