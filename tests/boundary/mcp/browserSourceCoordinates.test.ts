import { expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

const positions = [
  {
    name: "malformed",
    declaration: { lineNumber: -3, columnNumber: 7.5 },
    observed: { line: null, column: null },
  },
  {
    name: "inline",
    declaration: { lineNumber: 21, columnNumber: -40 },
    observed: { line: 21, column: -40 },
  },
] as const;

it("keeps valid and malformed producer source coordinates distinct through MCP", async () => {
  const browser = await startFakeCdpBrowser({
    webMcpTools: true,
    commandEvents(command, origin) {
      const session =
        command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      const stack = ({ name, declaration }: (typeof positions)[number]) => ({
        callFrames: [{ url: `${origin}/${name}.js`, ...declaration }],
      });
      switch (command.method) {
        case "Runtime.enable":
          return positions.map((position, index) => ({
            ...session,
            method: "Runtime.consoleAPICalled",
            params: {
              type: "log",
              timestamp: index + 1,
              args: [],
              stackTrace: stack(position),
            },
          }));
        case "Network.enable":
          return positions.map((position, index) => ({
            ...session,
            method: "Network.requestWillBeSent",
            params: {
              requestId: position.name,
              timestamp: index + 1,
              type: "Script",
              request: {
                url: `${origin}/${position.name}.js`,
                method: "GET",
              },
              initiator: { type: "script", stack: stack(position) },
            },
          }));
        case "WebMCP.enable":
          return [
            {
              ...session,
              method: "WebMCP.toolsAdded",
              params: {
                tools: positions.map((position) => ({
                  name: position.name,
                  frameId: "frame-main",
                  stackTrace: stack(position),
                })),
              },
            },
          ];
        default:
          return undefined;
      }
    },
  });
  onTestFinished(() => browser.close());
  const { client } = await createApplicationMcpHarness({
    serverOptions: { browserObservation: new CdpBrowserProvider() },
  });
  const args = {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  };
  const definitions = (await client.listTools()).tools;
  const call = async (name: "inspect_web_page" | "discover_webmcp_tools") => {
    const definition = definitions.find((tool) => tool.name === name);
    if (definition === undefined)
      throw new Error(`Missing advertised output schema: ${name}`);
    const reply = await client.callTool(
      { name, arguments: args },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    return reply.structuredContent;
  };
  const observed = positions.map(({ name, observed }) => ({
    name,
    location: { url: `${browser.allowedOrigin}/${name}.js`, ...observed },
  }));
  const invalid = (section: string) => ({
    section,
    reason: "invalid_protocol_value",
    count: 1,
  });

  expect(await call("inspect_web_page")).toMatchObject({
    normalized_result: {
      console: { events: observed.map(({ location }) => location) },
      network: {
        requests: observed.map(({ name, location }) => ({
          request_id: name,
          initiator: location,
        })),
      },
      completeness: {
        excluded: expect.arrayContaining([
          invalid("console_events"),
          invalid("network_initiators"),
        ]),
      },
    },
  });
  expect(await call("discover_webmcp_tools")).toMatchObject({
    normalized_result: {
      tools: {
        total: 2,
        items: expect.arrayContaining(
          observed.map(({ name, location }) =>
            expect.objectContaining({
              name,
              registration_source: name === "malformed" ? null : location,
            }),
          ),
        ),
      },
      completeness: {
        excluded: expect.arrayContaining([invalid("webmcp_tools")]),
      },
    },
  });
});
