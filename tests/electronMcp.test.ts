import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

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
    const root = await mkdtemp(join(tmpdir(), "rea-electron-mcp-"));
    temporary.push(root);
    await writeFile(join(root, "index.html"), "<script src='app.js'></script>");
    await writeFile(join(root, "app.js"), "export const app = true;");
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(join(root, "index.html")).href,
    });
    browsers.push(browser);
    const config = parseConfig({
      REA_ELECTRON_OBSERVE_ENABLED: "true",
      REA_ELECTRON_CDP_ENDPOINTS_JSON: JSON.stringify([browser.endpoint]),
      REA_ELECTRON_FILE_ROOTS_JSON: JSON.stringify([root]),
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
      operation: "list_electron_targets",
      provider: { id: "rea-cdp-electron" },
      normalized_result: {
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
      },
    });
    expect(inspected.isError).not.toBe(true);
    expect(inspected.structuredContent).toMatchObject({
      operation: "inspect_electron_page",
      normalized_result: {
        target: { file_path: join(root, "index.html") },
        scripts: {
          items: [expect.objectContaining({ file_path: join(root, "app.js") })],
        },
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
        details: { missing: { roots: [outside] } },
      },
    });
    expect(browser.commands).toHaveLength(commandsBeforeDenial);
  });
});
