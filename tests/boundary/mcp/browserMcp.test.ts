import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { crc32, deflateSync } from "node:zlib";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { webPageInspectionSchema } from "../../../src/domain/browserObservationSchemas.js";
import { createWebScreenshotArtifact } from "../../../src/domain/webScreenshot.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../../src/contracts/javascript/javascriptRuntimeReconciliationExample.js";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";
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
    const connected = await connectBrowser();

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
    const sessionStatus = toolContract("binary_session").outputSchema.parse(
      status.structuredContent,
    );
    const availability = expandToolAvailability(
      sessionStatus.result.tool_availability,
    );
    expect(availability).toContainEqual(
      expect.objectContaining({
        name: "inspect_web_page",
        reason: expect.any(String),
      }),
    );
    const listed = await connected.client.callTool({
      name: "list_browser_targets",
      arguments: {
        cdp_endpoint: browser.endpoint,
      },
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      normalized_result: {
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
        static_layers: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
        runtime_observations: [evidenceFor(inspected.structuredContent)],
      },
    });
    expect(reconciled.isError).not.toBe(true);
    expect(reconciled.structuredContent).toMatchObject({
      normalized_result: { summary: { runtime_scripts: 1 } },
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
      normalized_result: {
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
      observation_ms: 0,
    },
  });
  expect(webMcp.isError).not.toBe(true);
  expect(webMcp.structuredContent).toMatchObject({
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
    normalized_result: { overall_status: "unknown" },
  });
  const parsedCapture = webPageInspectionSchema.parse(capture);
  const socket = parsedCapture.network.websocket_connections
    .flatMap((connection) => connection.events)
    .find((event) => event.payload_shape?.json_shape != null);
  const payload = socket?.payload_shape;
  if (socket === undefined || payload == null || payload.json_shape === null)
    throw new Error("Missing deep WebSocket JSON shape fixture");
  const malformedCapture = {
    ...parsedCapture,
    network: {
      ...parsedCapture.network,
      websocket_connections: parsedCapture.network.websocket_connections.map(
        (connection) => ({
          ...connection,
          events: connection.events.map((event) =>
            event === socket
              ? {
                  ...event,
                  payload_shape: {
                    ...payload,
                    json_shape: {
                      ...payload.json_shape,
                      properties: [
                        { path: "/event", types: [42], observations: 1 },
                      ],
                    },
                  },
                }
              : event,
          ),
        }),
      ),
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
    normalized_result: { status: "identical", changed_pixels: 0 },
  });

  await assertScreenshotPngFailures(connected.client);
  expect(inspected.structuredContent).toMatchObject({
    normalized_result: expect.any(Object),
    operation: "inspect_web_page",
    predicate_type: expect.any(String),
    parameters: expect.any(Object),
  });
};

const pngChunk = (type: string, data: Buffer): Buffer => {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return chunk;
};

const assertScreenshotPngFailures = async (client: Client): Promise<void> => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const malformedPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from("bad")),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const malformedArtifact = createWebScreenshotArtifact(malformedPng);
  const malformed = await client.callTool({
    name: "compare_web_screenshots",
    arguments: {
      before: malformedArtifact,
      after: malformedArtifact,
    },
  });
  expect(parseMcpToolError(malformed)).toMatchObject({
    error: {
      code: "invalid_request",
      category: "invalid_input",
      details: {
        operation: "compare_web_screenshots",
        issues: [{ path: [], reason: "invalid_format" }],
      },
    },
  });

  const grayscaleHeader = Buffer.alloc(13);
  grayscaleHeader.writeUInt32BE(1, 0);
  grayscaleHeader.writeUInt32BE(1, 4);
  grayscaleHeader.set([8, 0, 0, 0, 0], 8);
  const unsupportedPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", grayscaleHeader),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 30]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const unsupported = createWebScreenshotArtifact(unsupportedPng);
  const rejectedFormat = await client.callTool({
    name: "compare_web_screenshots",
    arguments: { before: unsupported, after: unsupported },
  });
  expect(parseMcpToolError(rejectedFormat)).toMatchObject({
    error: { code: "unsupported_target", category: "unsupported_target" },
  });
};

it("delivers the source-map response URL through authenticated MCP Evidence", async () => {
  const terminalPath = "/maps/v1/app.js.map?revision=2&token=source-value";
  const browser = await startFakeCdpBrowser({
    sourceMapRedirect: terminalPath,
    sourceMapBody: JSON.stringify({
      version: 3,
      names: [],
      sources: ["../src/original.js"],
      sourcesContent: ["export const value = 1;"],
      mappings: "AAAA",
    }),
  });
  browsers.push(browser);
  const connected = await connectBrowser();
  const result = await connected.client.callTool({
    name: "analyze_web_bundle",
    arguments: {
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      allowed_origins: [browser.allowedOrigin],
      observation_ms: 0,
      fetch_source_maps: true,
    },
  });
  expect(result.isError).not.toBe(true);
  const evidence = parseEvidence(result.structuredContent);
  const expectedResult = {
    observations: {
      source_maps: {
        status: "included",
        items: [
          {
            declared_url: `${browser.allowedOrigin}/app.js.map?token=map-secret`,
            effective_url: `${browser.allowedOrigin}${terminalPath}`,
            original_sources: [
              { source: `${browser.allowedOrigin}/maps/src/original.js` },
            ],
          },
        ],
      },
    },
  };
  expect(evidence.normalized_result).toMatchObject(expectedResult);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: JSON.stringify(evidence),
  });
  const cliEvidence = parseEvidence(
    await runCliJson([
      "analyze-web-bundle",
      browser.endpoint,
      "allowed-page",
      "--allowed-origins",
      browser.allowedOrigin,
      "--observation-ms",
      "0",
      "--fetch-source-maps",
      "--json",
    ]),
  );
  expect(cliEvidence.normalized_result).toMatchObject(expectedResult);
  const mapRequests = browser.httpRequests.filter(({ url }) =>
    url.includes(".map"),
  );
  expect(mapRequests.map(({ url }) => url)).toEqual([
    "/app.js.map?token=map-secret",
    terminalPath,
    "/app.js.map?token=map-secret",
    terminalPath,
  ]);
  expect(
    mapRequests.every(
      ({ authorization, cookie, referer }) =>
        authorization === undefined &&
        cookie === undefined &&
        referer === undefined,
    ),
  ).toBe(true);
});

it("records a browser-socket endpoint redacted and reconciles its Evidence", async () => {
  const browser = await startFakeCdpBrowser();
  browsers.push(browser);
  const connected = await connectBrowser();
  const tool = (await connected.client.listTools()).tools.find(
    ({ name }) => name === "inspect_web_page",
  );
  expect(tool?.inputSchema.properties?.cdp_endpoint).toMatchObject({
    description: expect.stringContaining("/devtools/browser/ID"),
  });
  const inspected = await connected.client.callTool({
    name: "inspect_web_page",
    arguments: {
      cdp_endpoint: browser.browserWebSocketUrl,
      target_id: "allowed-page",
      observation_ms: 0,
      include_script_sources: true,
    },
  });
  expect(inspected.isError).not.toBe(true);
  expect(inspected.structuredContent).toMatchObject({
    parameters: {
      cdp_endpoint: browser.browserWebSocketUrl.replace(/fake$/u, "[REDACTED]"),
    },
  });
  expect(JSON.stringify(inspected.structuredContent)).not.toContain(
    "/devtools/browser/fake",
  );
  const reconciled = await connected.client.callTool({
    name: "reconcile_javascript_runtime",
    arguments: {
      static_layers: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
      runtime_observations: [evidenceFor(inspected.structuredContent)],
    },
  });
  expect(reconciled.isError).not.toBe(true);
  expect(reconciled.structuredContent).toMatchObject({
    normalized_result: { summary: { runtime_scripts: 1 } },
  });
});

it("does not attach to a target outside the request's allowed origin scope", async () => {
  const browser = await startFakeCdpBrowser();
  browsers.push(browser);
  const connected = await connectBrowser();
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
  expect(parseMcpToolError(result)).toMatchObject({
    error: {
      details: {
        operation: "inspect_web_page",
        reason: "target_not_allowed",
      },
    },
  });
  expect(browser.commands).toHaveLength(0);
});

it("projects legal oversized PNG dimensions as a memory constraint", async () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(0x7fffffff, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const artifact = createWebScreenshotArtifact(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(Buffer.from([0]))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
  const connected = await connectBrowser();
  const result = await connected.client.callTool({
    name: "compare_web_screenshots",
    arguments: { before: artifact, after: artifact },
  });

  expect(parseMcpToolError(result)).toMatchObject({
    error: {
      code: "resource_constraint",
      category: "resource_constraint",
      details: {
        operation: "compare_web_screenshots",
        resource: "memory",
        reported_limits: {
          maximum_working_memory_bytes: 256 * 1024 * 1024,
          estimated_working_memory_bytes: "34359738499",
          before_dimensions: { width: 0x7fffffff, height: 1 },
          after_dimensions: { width: 0x7fffffff, height: 1 },
        },
      },
    },
  });
});

const connectBrowser = async () => {
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer(
    { kind: "session", session },
    {
      browserObservation: new CdpBrowserProvider(),
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
        investigationInputRoots: 0,
      }),
    },
  );
  const client = new Client({ name: "browser-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, session };
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

const evidenceFor = (value: unknown) => {
  return parseEvidence(value);
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
