import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import { loadConfiguredPermissionAuthority } from "../src/application/PermissionConfiguration.js";
import { CdpBrowserProvider } from "../src/browser/CdpBrowserProvider.js";
import { parseConfig } from "../src/config.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../src/contracts/javascriptRuntimeReconciliationExample.js";
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
      const browser = await startFakeCdpBrowser({
        sessionTimeline: "same_origin",
        webMcpTools: true,
        sensitiveShapes: true,
      });
      browsers.push(browser);
      const connected = await connectBrowser(browser);

      const tools = await connected.client.listTools();
      expect(tools.tools).toHaveLength(84);
      expect(tools.tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "list_browser_targets",
          "inspect_web_page",
          "analyze_web_bundle",
          "observe_web_session",
          "discover_webmcp_tools",
          "compare_web_captures",
          "capture_web_screenshot",
          "compare_web_screenshots",
          "list_electron_targets",
          "inspect_electron_page",
        ]),
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
        provider: { id: "rea-cdp-browser", version: "2" },
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
          include_console_text: true,
          console_text_approved: true,
          include_json_body_shapes: true,
          json_body_schema_approved: true,
          include_websocket_shapes: true,
          websocket_shape_approved: true,
          include_script_sources: true,
        },
      });
      expect(inspected.isError).not.toBe(true);
      expect(inspected.structuredContent).toMatchObject({
        operation: "inspect_web_page",
        normalized_result: {
          target: { target_id: "allowed-page" },
          console: { prior_activity_available: false },
          network: {
            prior_activity_available: false,
            requests: [
              expect.objectContaining({
                body_shapes: expect.objectContaining({ status: "included" }),
              }),
            ],
          },
        },
      });
      const reconciled = await connected.client.callTool({
        name: "reconcile_javascript_runtime",
        arguments: {
          static_layers:
            JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
          runtime_observations: [inspected.structuredContent],
        },
      });
      expect(reconciled.isError).not.toBe(true);
      expect(reconciled.structuredContent).toMatchObject({
        operation: "reconcile_javascript_runtime",
        provider: { id: "rea-javascript-runtime-reconciliation" },
        normalized_result: { summary: { runtime_scripts: 1 } },
      });
      expect(JSON.stringify(reconciled.structuredContent)).not.toContain(
        "source-secret",
      );
      const analyzed = await connected.client.callTool({
        name: "analyze_web_bundle",
        arguments: {
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          approved: true,
          source_capture_approved: true,
          observation_ms: 0,
        },
      });
      expect(analyzed.isError).not.toBe(true);
      expect(analyzed.structuredContent).toMatchObject({
        operation: "analyze_web_bundle",
        normalized_result: {
          capture: { scripts_analyzed: 1 },
          observations: { source_maps: { status: "not_requested" } },
        },
      });
      const observedSession = await connected.client.callTool({
        name: "observe_web_session",
        arguments: {
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          approved: true,
          observation_ms: 5,
        },
      });
      expect(observedSession.isError).not.toBe(true);
      expect(observedSession.structuredContent).toMatchObject({
        operation: "observe_web_session",
        normalized_result: {
          window: { end_reason: "window_elapsed" },
          timeline: expect.arrayContaining([
            expect.objectContaining({ type: "same_origin_reload" }),
          ]),
        },
      });
      const webMcp = await connected.client.callTool({
        name: "discover_webmcp_tools",
        arguments: {
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          approved: true,
          observation_ms: 0,
        },
      });
      expect(webMcp.isError).not.toBe(true);
      expect(webMcp.structuredContent).toMatchObject({
        operation: "discover_webmcp_tools",
        normalized_result: {
          tools: {
            items: [expect.objectContaining({ name: "search_orders" })],
          },
        },
      });
      const capture = normalizedResultOf(inspected.structuredContent);
      const compared = await connected.client.callTool({
        name: "compare_web_captures",
        arguments: {
          before: { inspection: capture },
          after: { inspection: capture },
        },
      });
      expect(compared.isError).not.toBe(true);
      expect(compared.structuredContent).toMatchObject({
        operation: "compare_web_captures",
        normalized_result: { overall_status: "unknown" },
      });
      const screenshot = await connected.client.callTool({
        name: "capture_web_screenshot",
        arguments: {
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          approved: true,
          screenshot_approved: true,
        },
      });
      expect(screenshot.isError).not.toBe(true);
      const screenshotArtifact = artifactOf(screenshot.structuredContent);
      const visual = await connected.client.callTool({
        name: "compare_web_screenshots",
        arguments: {
          before: screenshotArtifact,
          after: screenshotArtifact,
        },
      });
      expect(visual.isError).not.toBe(true);
      expect(visual.structuredContent).toMatchObject({
        operation: "compare_web_screenshots",
        normalized_result: { status: "identical", changed_pixels: 0 },
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

const normalizedResultOf = (value: unknown): unknown => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("normalized_result" in value)
  )
    throw new TypeError("Missing normalized browser result");
  return value.normalized_result;
};

const artifactOf = (value: unknown): unknown => {
  const normalized = normalizedResultOf(value);
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    !("artifact" in normalized)
  )
    throw new TypeError("Missing screenshot artifact");
  return normalized.artifact;
};
