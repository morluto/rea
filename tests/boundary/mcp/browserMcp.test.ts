import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { webPageInspectionSchema } from "../../../src/domain/browserObservation.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../../src/contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

const resources: Array<{ close(): Promise<unknown> }> = [];
const browsers: FakeCdpBrowser[] = [];
const INTEGRATION_TEST_TIMEOUT_MS = 20_000;

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

it(
  "exposes CLI-equivalent Evidence results and session tools",
  async () => {
    const browser = await startFakeCdpBrowser({
      sessionTimeline: "same_origin",
      webMcpTools: true,
      sensitiveShapes: true,
    });
    browsers.push(browser);
    const connected = await connectBrowser(browser);

    const tools = await connected.client.listTools();
    expect(tools.tools).toHaveLength(TOOL_CONTRACTS.length);
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
            reason: expect.any(String),
          }),
        ]),
      },
    });
    const listed = await connected.client.callTool({
      name: "list_browser_targets",
      arguments: {
        cdp_endpoint: browser.endpoint,
      },
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      result: {
        targets: expect.arrayContaining([
          expect.objectContaining({ target_id: "allowed-page" }),
        ]),
      },
    });
    const inspected = await connected.client.callTool({
      name: "inspect_web_page",
      arguments: {
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 0,
        include_console_text: true,
        include_json_body_shapes: true,
        include_websocket_shapes: true,
        include_script_sources: true,
      },
    });
    expect(inspected.isError).not.toBe(true);
    expect(inspected.structuredContent).toMatchObject({
      result: {
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
        static_layers: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
        runtime_observations: [evidenceFor(inspected.structuredContent)],
      },
    });
    expect(reconciled.isError).not.toBe(true);
    expect(reconciled.structuredContent).toMatchObject({
      result: { summary: { runtime_scripts: 1 } },
    });
    expect(JSON.stringify(reconciled.structuredContent)).not.toContain(
      "source-secret",
    );
    const analyzed = await connected.client.callTool({
      name: "analyze_web_bundle",
      arguments: {
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 0,
      },
    });
    expect(analyzed.isError).not.toBe(true);
    expect(analyzed.structuredContent).toMatchObject({
      result: {
        capture: { scripts_analyzed: 1 },
        observations: { source_maps: { status: "not_requested" } },
      },
    });
    await verifySessionAndComparisonTools(connected, browser, inspected);
  },
  INTEGRATION_TEST_TIMEOUT_MS,
);

const verifySessionAndComparisonTools = async (
  connected: Awaited<ReturnType<typeof connectBrowser>>,
  browser: FakeCdpBrowser,
  inspected: Awaited<ReturnType<Client["callTool"]>>,
): Promise<void> => {
  const observedSession = await connected.client.callTool({
    name: "observe_web_session",
    arguments: {
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 5,
    },
  });
  expect(observedSession.isError).not.toBe(true);
  expect(observedSession.structuredContent).toMatchObject({
    result: {
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
      observation_ms: 0,
    },
  });
  expect(webMcp.isError).not.toBe(true);
  expect(webMcp.structuredContent).toMatchObject({
    result: {
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
    result: { overall_status: "unknown" },
  });
  const parsedCapture = webPageInspectionSchema.parse(capture);
  const socket = parsedCapture.network.websocket_events.find(
    (event) => event.payload_shape?.json_shape != null,
  );
  const payload = socket?.payload_shape;
  if (socket === undefined || payload == null || payload.json_shape === null)
    throw new Error("Missing deep WebSocket JSON shape fixture");
  const malformedCapture = {
    ...parsedCapture,
    network: {
      ...parsedCapture.network,
      websocket_events: [
        {
          ...socket,
          payload_shape: {
            ...payload,
            json_shape: {
              ...payload.json_shape,
              properties: [{ path: "/event", types: [42], observations: 1 }],
            },
          },
        },
      ],
    },
  };
  const malformedComparison = await connected.client.callTool({
    name: "compare_web_captures",
    arguments: {
      before: { inspection: malformedCapture },
      after: { inspection: capture },
    },
  });
  expect(malformedComparison.isError).toBe(true);
  expect(JSON.stringify(malformedComparison.content)).toContain("types");
  const incompleteComparison = await connected.client.callTool({
    name: "compare_web_captures",
    arguments: { before: { inspection: capture } },
  });
  expect(incompleteComparison.isError).toBe(true);
  const screenshot = await connected.client.callTool({
    name: "capture_web_screenshot",
    arguments: {
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
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
    result: { status: "identical", changed_pixels: 0 },
  });
  expect(inspected.structuredContent).toMatchObject({
    result: expect.any(Object),
    evidence: {
      operation: "inspect_web_page",
      predicate_type: expect.any(String),
      parameters: expect.any(Object),
    },
  });
};

it("does not attach to a target outside the request's allowed origin scope", async () => {
  const browser = await startFakeCdpBrowser();
  browsers.push(browser);
  const connected = await connectBrowser(browser);
  const result = await connected.client.callTool({
    name: "inspect_web_page",
    arguments: {
      cdp_endpoint: browser.endpoint,
      allowed_origins: ["https://unapproved.example.test"],
      target_id: "allowed-page",
      observation_ms: 0,
    },
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      details: {
        operation: "inspect_web_page",
        reason: "target_not_allowed",
      },
    },
  });
  expect(browser.commands).toHaveLength(0);
});

const connectBrowser = async (browser: FakeCdpBrowser) => {
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session, {
    browserObservation: new CdpBrowserProvider(),
    availabilityPolicy: () => ({
      processCaptureEnabled: false,
      investigationInputRoots: 0,
    }),
  });
  const client = new Client({ name: "browser-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, session };
};

const normalizedResultOf = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || !("result" in value))
    throw new TypeError("Missing normalized browser result");
  return value.result;
};

const evidenceFor = (value: unknown) => {
  const parsed = z
    .object({
      evidence_id: z.string(),
      result: z.unknown(),
      evidence: z.object({}).passthrough(),
    })
    .parse(value);
  return {
    ...parsed.evidence,
    evidence_id: parsed.evidence_id,
    normalized_result: parsed.result,
  };
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
