import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { webPageInspectionSchema } from "../../../src/domain/browserObservationSchemas.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves quoted Permissions-Policy boundaries through CLI and named MCP schemas",
  async ({ cli }) => {
    const { client, call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "browser",
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
    });
    const definition = (await client.listTools()).tools.find(
      ({ name }) => name === "inspect_web_page",
    );
    if (definition === undefined)
      throw new Error("Missing inspect_web_page definition");
    const input = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(definition.inputSchema);
    for (const policy of [
      "camera=(), geolocation=(self)",
      'camera=();note="one, microphone=(), tail", geolocation=(self)',
    ]) {
      const browser = await startFakeCdpBrowser({
        eventsBeforeReply: ["Network.enable"],
        commandEvents(command, origin) {
          if (command.method !== "Network.enable") return undefined;
          const session =
            command.sessionId === undefined
              ? {}
              : { sessionId: command.sessionId };
          const url = `${origin}/permissions`;
          return [
            {
              ...session,
              method: "Network.requestWillBeSent",
              params: {
                requestId: "policy-request",
                type: "Fetch",
                timestamp: 7,
                request: { url, method: "GET" },
                initiator: { type: "other" },
              },
            },
            {
              ...session,
              method: "Network.responseReceived",
              params: {
                requestId: "policy-request",
                timestamp: 8,
                response: {
                  url,
                  status: 200,
                  mimeType: "text/plain",
                  headers: {
                    "Content-Length": "4",
                    "Permissions-Policy": policy,
                    Link: '</asset,part.js>;rel="preload";title="a,b", </next.js>;rel=mcp',
                  },
                },
              },
            },
            {
              ...session,
              method: "Network.loadingFinished",
              params: {
                requestId: "policy-request",
                timestamp: 9,
                encodedDataLength: 4,
              },
            },
          ];
        },
      });
      try {
        const response = await cli.run({
          arguments: [
            "inspect-web-page",
            browser.endpoint,
            "allowed-page",
            "--allowed-origins",
            browser.allowedOrigin,
            "--observation-ms",
            "0",
            "--json",
          ],
        });
        expect(response.exitCode, response.stdout).toBe(0);
        const args = {
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          allowed_origins: [browser.allowedOrigin],
          observation_ms: 0,
        };
        expect(input(args), JSON.stringify(input.errors)).toBe(true);
        const mcp = await call(definition.name, args);
        expect(mcp.isError).not.toBe(true);
        const link = (path: string, rel: string) => ({
          href: `${browser.allowedOrigin}${path}`,
          destination_scope: "approved",
          context_url: `${browser.allowedOrigin}/permissions`,
          context_scope: "approved",
          rel: [rel],
          as: null,
          type: null,
          crossorigin: null,
        });
        const expected = {
          request_id: "policy-request",
          url: `${browser.allowedOrigin}/permissions`,
          mime_type: "text/plain",
          content_length: 4,
          content_encoding: null,
          csp: { directives: [], nonce_count: 0, hash_count: 0 },
          links: [link("/asset,part.js", "preload"), link("/next.js", "mcp")],
          policies: {
            coop: null,
            coep: null,
            corp: null,
            referrer_policy: null,
            x_content_type_options: null,
            permissions_policy_features: ["camera", "geolocation"],
          },
        };
        for (const evidence of [response.json, mcp.structuredContent]) {
          const page = webPageInspectionSchema.parse(
            parseEvidence(evidence).normalized_result,
          );
          expect.soft(page.metadata.responses).toEqual([expected]);
        }
        expect(
          browser.commands.some(({ method }) => method === "Page.navigate"),
        ).toBe(false);
        expect(browser.activeConnectionCount()).toBe(0);
      } finally {
        await browser.close();
      }
    }
  },
);
