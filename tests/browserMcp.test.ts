import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import { loadConfiguredPermissionAuthority } from "../src/application/PermissionConfiguration.js";
import { CdpBrowserProvider } from "../src/browser/CdpBrowserProvider.js";
import { parseConfig } from "../src/config.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "./fixtures/fakeCdpBrowser.js";

const resources: Array<{ close(): Promise<unknown> }> = [];
const browsers: FakeCdpBrowser[] = [];
const INTEGRATION_TEST_TIMEOUT_MS = 20_000;

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

describe("browser MCP tools", () => {
  it(
    "exposes CLI-equivalent Evidence v2 and session resources",
    async () => {
      const browser = await startFakeCdpBrowser();
      browsers.push(browser);
      const connected = await connectBrowser(browser);

      const tools = await connected.client.listTools();
      expect(tools.tools).toHaveLength(70);
      expect(tools.tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["list_browser_targets", "inspect_web_page"]),
      );
      const status = await connected.client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(status.structuredContent).toMatchObject({
        result: {
          tool_availability: expect.arrayContaining([
            expect.objectContaining({
              name: "inspect_web_page",
              available: true,
              reason: "available",
            }),
          ]),
        },
      });
      const listed = await connected.client.callTool({
        name: "list_browser_targets",
        arguments: {
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          approved: true,
        },
      });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({
        operation: "list_browser_targets",
        authority: "external-service",
        confidence: "observed",
        subject: null,
        provider: { id: "rea-cdp-browser", version: "1" },
        normalized_result: {
          targets: { items: [{ target_id: "allowed-page" }] },
        },
      });
      const inspected = await connected.client.callTool({
        name: "inspect_web_page",
        arguments: {
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          approved: true,
          observation_ms: 0,
        },
      });
      expect(inspected.isError).not.toBe(true);
      expect(inspected.structuredContent).toMatchObject({
        operation: "inspect_web_page",
        normalized_result: {
          target: { target_id: "allowed-page" },
          network: { prior_activity_available: false },
          console: { prior_activity_available: false },
        },
      });
      const evidenceId = evidenceIdOf(inspected.structuredContent);
      const evidence = await connected.client.readResource({
        uri: `rea://evidence/${evidenceId}`,
      });
      expect(evidence.contents[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining(evidenceId) }),
      );
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it("denies origins outside the administrator ceiling before CDP attach", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const connected = await connectBrowser(browser);
    const denied = await connected.client.callTool({
      name: "inspect_web_page",
      arguments: {
        cdp_endpoint: browser.endpoint,
        allowed_origins: ["https://unapproved.example.test"],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: {
        code: "permission_required",
        details: {
          missing: { origins: ["https://unapproved.example.test"] },
        },
      },
    });
    expect(browser.commands).toHaveLength(0);
  });
});

const connectBrowser = async (browser: FakeCdpBrowser) => {
  const config = parseConfig({
    REA_BROWSER_OBSERVE_ENABLED: "true",
    REA_BROWSER_CDP_ENDPOINTS_JSON: JSON.stringify([browser.endpoint]),
    REA_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify([browser.allowedOrigin]),
  });
  if (!config.ok) throw config.error;
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok) throw authority.error;
  const session = new BinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session, {
    browserObservation: new CdpBrowserProvider(),
    permissionAuthority: authority.value,
    availabilityPolicy: () => ({
      processCaptureEnabled: false,
      evidenceFileRoots: 0,
      browserObservationEnabled: true,
    }),
  });
  const client = new Client({ name: "browser-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
};

const evidenceIdOf = (value: unknown): string => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("evidence_id" in value) ||
    typeof value.evidence_id !== "string"
  )
    throw new TypeError("Missing browser evidence ID");
  return value.evidence_id;
};
