import { expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

/** Report one call frame for a console event, a request initiator and a WebMCP registration. */
const inspectSourceCoordinates = async (position: {
  readonly lineNumber: number;
  readonly columnNumber: number;
}) => {
  const browser = await startFakeCdpBrowser({
    webMcpTools: true,
    webMcpStackTrace: (origin) => ({
      callFrames: [{ url: `${origin}/app.js`, ...position }],
    }),
    commandEvents(command, origin) {
      const frame = { url: `${origin}/app.js`, ...position };
      const session =
        command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      if (command.method === "Runtime.enable")
        return [
          {
            ...session,
            method: "Runtime.consoleAPICalled",
            params: {
              type: "log",
              timestamp: 1,
              args: [],
              stackTrace: { callFrames: [frame] },
            },
          },
        ];
      if (command.method === "Network.enable")
        return [
          {
            ...session,
            method: "Network.requestWillBeSent",
            params: {
              requestId: "coordinate-request",
              timestamp: 1,
              type: "Script",
              request: { url: `${origin}/app.js`, method: "GET" },
              initiator: { type: "script", stack: { callFrames: [frame] } },
            },
          },
        ];
      return undefined;
    },
  });
  onTestFinished(() => browser.close());
  const { client } = await createApplicationMcpHarness({
    clientIdentity: { name: "source-coordinate-test", version: "1" },
    serverOptions: {
      environment: { ...process.env },
      browserObservation: new CdpBrowserProvider(),
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
        investigationInputRoots: 0,
      }),
    },
  });
  const args = {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  };
  const definitions = (await client.listTools()).tools;
  const call = async (name: "inspect_web_page" | "discover_webmcp_tools") => {
    const toolDefinition = definitions.find((tool) => tool.name === name);
    if (toolDefinition?.outputSchema === undefined)
      throw new Error(`Missing advertised output schema: ${name}`);
    return client.callTool({ name, arguments: args }, { toolDefinition });
  };
  const page = await call("inspect_web_page");
  const tools = await call("discover_webmcp_tools");
  return { page, tools };
};

it("reports malformed source coordinates as unknown through MCP", async () => {
  const { page, tools } = await inspectSourceCoordinates({
    lineNumber: -3,
    columnNumber: 7.5,
  });
  expect(page.isError).not.toBe(true);
  expect(page.structuredContent).toMatchObject({
    normalized_result: {
      console: {
        events: [expect.objectContaining({ line: null, column: null })],
      },
      network: {
        requests: expect.arrayContaining([
          expect.objectContaining({
            request_id: "coordinate-request",
            initiator: expect.objectContaining({ line: null, column: null }),
          }),
        ]),
      },
      completeness: {
        excluded: expect.arrayContaining([
          expect.objectContaining({
            section: "console_events",
            reason: "invalid_protocol_value",
          }),
          expect.objectContaining({
            section: "network_initiators",
            reason: "invalid_protocol_value",
          }),
        ]),
      },
    },
  });
  expect(tools.isError).not.toBe(true);
  expect(tools.structuredContent).toMatchObject({
    normalized_result: {
      tools: {
        items: [expect.objectContaining({ registration_source: null })],
      },
      completeness: {
        excluded: expect.arrayContaining([
          expect.objectContaining({
            section: "webmcp_tools",
            reason: "invalid_protocol_value",
          }),
        ]),
      },
    },
  });
}, 20_000);

it("keeps a negative column Chrome reports in passive source locations", async () => {
  const { page, tools } = await inspectSourceCoordinates({
    lineNumber: 21,
    columnNumber: -40,
  });
  for (const response of [page, tools]) {
    expect(response.isError).not.toBe(true);
  }
  const location = { line: 21, column: -40 };
  expect(page.structuredContent).toMatchObject({
    normalized_result: {
      console: { events: [expect.objectContaining(location)] },
      network: {
        requests: expect.arrayContaining([
          expect.objectContaining({
            request_id: "coordinate-request",
            initiator: expect.objectContaining(location),
          }),
        ]),
      },
    },
  });
  expect(tools.structuredContent).toMatchObject({
    normalized_result: {
      tools: {
        items: [
          expect.objectContaining({
            registration_source: expect.objectContaining(location),
          }),
        ],
      },
    },
  });
  for (const [response, section] of [
    [page, "console_events"],
    [page, "network_initiators"],
    [tools, "webmcp_tools"],
  ] as const)
    expect(response.structuredContent).toMatchObject({
      normalized_result: {
        completeness: {
          excluded: expect.not.arrayContaining([
            expect.objectContaining({
              section,
              reason: "invalid_protocol_value",
            }),
          ]),
        },
      },
    });
}, 20_000);
