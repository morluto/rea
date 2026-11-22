import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

it.each([
  {
    name: "malformed UTF-8",
    cases: [
      ["invalid-key", Buffer.from('{"\xff":true}', "latin1"), null],
      ["invalid-value", Buffer.from('{"k":"\xff"}', "latin1"), null],
      ["overlong-key", Buffer.from('{"\xc0\xaf":true}', "latin1"), null],
    ],
  },
  {
    name: "valid UTF-8",
    cases: [
      ["accented-key", Buffer.from('{"é":true}'), "é"],
      ["replacement-key", Buffer.from('{"�":true}'), "�"],
    ],
  },
] as const)(
  "keeps $name response body facts tied to their request",
  async ({ cases }) => {
    const exchanges = cases.flatMap(([id, body, property]) =>
      [false, true].map((hasRequestShape) => ({
        requestId: `${id}-${hasRequestShape ? "post" : "get"}`,
        body,
        property,
        hasRequestShape,
      })),
    );
    const browser = await startFakeCdpBrowser({
      eventsBeforeReply: ["Network.enable"],
      commandEvents(command, origin) {
        if (command.method !== "Network.enable") return [];
        return exchanges.flatMap(({ requestId, body, hasRequestShape }) => {
          const url = `${origin}/${requestId}`;
          return [
            {
              sessionId: command.sessionId,
              method: "Network.requestWillBeSent",
              params: {
                requestId,
                request: hasRequestShape
                  ? {
                      url,
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      postData: '{"request":true}',
                    }
                  : { url, method: "GET" },
                initiator: { type: "other" },
              },
            },
            {
              sessionId: command.sessionId,
              method: "Network.responseReceived",
              params: {
                requestId,
                response: { url, status: 200, mimeType: "application/json" },
              },
            },
            {
              sessionId: command.sessionId,
              method: "Network.loadingFinished",
              params: { requestId, encodedDataLength: body.length },
            },
          ];
        });
      },
      commandResult(command) {
        if (command.method !== "Network.getResponseBody") return undefined;
        const exchange = exchanges.find(
          ({ requestId }) => requestId === command.params.requestId,
        );
        if (exchange === undefined) throw new Error("Unexpected body request");
        return { body: exchange.body.toString("base64"), base64Encoded: true };
      },
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
        include_json_body_shapes: true,
      }),
    );
    if (!result.ok) throw result.error;

    expect(result.value.network.requests).toEqual(
      exchanges.map(({ requestId, body, property, hasRequestShape }) =>
        expect.objectContaining({
          request_id: requestId,
          url: `${browser.allowedOrigin}/${requestId}`,
          status: 200,
          mime_type: "application/json",
          encoded_data_length: body.length,
          body_shapes: {
            status:
              property === null
                ? hasRequestShape
                  ? "partial"
                  : "unavailable"
                : "included",
            request: hasRequestShape
              ? expect.objectContaining({ root_type: "object" })
              : null,
            response:
              property === null
                ? null
                : {
                    root_type: "object",
                    node_count: 2,
                    max_depth_observed: 1,
                    properties: [
                      {
                        path: [{ kind: "property", name: property }],
                        types: ["boolean"],
                        observations: 1,
                      },
                    ],
                  },
          },
        }),
      ),
    );
    expect(
      browser.commands
        .filter(({ method }) => method === "Network.getResponseBody")
        .map(({ params }) => params.requestId),
    ).toEqual(exchanges.map(({ requestId }) => requestId));

    const unavailable = cases.some(([, , property]) => property === null);
    expect(
      result.value.completeness.unavailable_sections.includes(
        "json_body_shapes",
      ),
    ).toBe(unavailable);
    const bodyGap = {
      section: "json_body_shapes",
      reason: "provider_unavailable",
      count: null,
    };
    expect(
      result.value.completeness.excluded.filter(
        ({ section }) => section === "json_body_shapes",
      ),
    ).toEqual(unavailable ? [bodyGap] : []);
  },
);
