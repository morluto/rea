import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import type { CdpEvent } from "../../../src/browser/CdpConnection.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import type { FakeOptions } from "../../fixtures/fakeCdpBrowserTypes.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const inspectNetwork = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
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
  return { browser, inspection: result.value };
};

interface RedirectCase {
  readonly id: string;
  readonly continuation: { readonly redirectResponse?: unknown };
  readonly lateUrl?: string;
}

const redirectCases = (cases: readonly RedirectCase[]): FakeOptions => ({
  eventsBeforeReply: ["Network.enable"],
  commandEvents(command, origin) {
    if (command.method !== "Network.enable") return undefined;
    return cases.flatMap(({ id, continuation, lateUrl }) => {
      const request = (params: object): CdpEvent => ({
        sessionId: command.sessionId,
        method: "Network.requestWillBeSent",
        params: { requestId: id, initiator: { type: "other" }, ...params },
      });
      const response = (url: string, status: number): CdpEvent => ({
        sessionId: command.sessionId,
        method: "Network.responseReceived",
        params: {
          requestId: id,
          response: {
            url,
            status,
            mimeType: "application/json",
            headers: {
              "Content-Length": "123",
              "Content-Encoding": "gzip",
              "X-Private": "redirect-header-secret",
            },
          },
        },
      });
      const first = `${origin}/${id}/first`;
      const prior = `${origin}/${id}/prior`;
      const final = `${origin}/${id}/final`;
      return [
        request({ request: { url: first, method: "GET" }, timestamp: 7 }),
        request({
          request: {
            url: prior,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            postData: '{"preserved":true}',
          },
          redirectResponse: { url: first, status: 307, encodedDataLength: 23 },
          timestamp: 8,
        }),
        response(prior, 201),
        request({
          request: { url: final, method: "GET" },
          timestamp: 9,
          ...continuation,
        }),
        response(lateUrl ?? final, 200),
        {
          sessionId: command.sessionId,
          method: "Network.loadingFinished",
          params: { requestId: id, encodedDataLength: 777 },
        },
      ];
    });
  },
});

it.each([
  {
    label: "missing and malformed",
    urls: [{ status: 302 }, { url: "http://%", status: 302 }],
    reason: "invalid_protocol_value",
    section: "unavailable_sections",
  },
  {
    label: "unsupported",
    urls: [{ url: "file:///private/redirect", status: 302 }],
    reason: "unsupported_url",
    section: "policy_filtered_sections",
  },
] as const)(
  "keeps $label prior-hop URLs out of redirect chains",
  async ({ urls, reason, section }) => {
    const { inspection } = await inspectNetwork(
      redirectCases(
        urls.map((redirectResponse, index) => ({
          id: `bad-url-${String(index)}`,
          continuation: { redirectResponse },
        })),
      ),
    );
    expect(inspection.network.requests).toEqual([]);
    expect(
      inspection.completeness.excluded.filter(
        ({ section }) => section === "network_requests",
      ),
    ).toEqual([{ section: "network_requests", reason, count: urls.length }]);
    expect(inspection.completeness[section]).toContain("network_requests");
  },
);

it("retains the authorized predecessor when a redirect continuation is malformed", async () => {
  const cases: RedirectCase[] = [
    { id: "omitted", continuation: {} },
    { id: "null", continuation: { redirectResponse: null } },
    { id: "array", continuation: { redirectResponse: [] } },
    { id: "scalar", continuation: { redirectResponse: "malformed redirect" } },
    {
      id: "denied-late-response",
      continuation: { redirectResponse: null },
      lateUrl: "https://private.example.test/late?token=unauthorized-secret",
    },
  ];
  const { browser, inspection } = await inspectNetwork(redirectCases(cases));
  expect(inspection.network.requests).toEqual(
    cases.map(({ id }) =>
      expect.objectContaining({
        request_id: id,
        url: `${browser.allowedOrigin}/${id}/prior`,
        status: 201,
        mime_type: "application/json",
        encoded_data_length: null,
        redirects: [
          expect.objectContaining({
            url: `${browser.allowedOrigin}/${id}/first`,
            response_url: `${browser.allowedOrigin}/${id}/first`,
            request_timestamp: 7,
            redirect_event_timestamp: 8,
          }),
        ],
        body_shapes: {
          status: "partial",
          request: expect.objectContaining({ root_type: "object" }),
          response: null,
        },
      }),
    ),
  );
  expect(inspection.metadata.responses).toEqual(
    cases.map(({ id }) =>
      expect.objectContaining({
        request_id: id,
        url: `${browser.allowedOrigin}/${id}/prior`,
        mime_type: "application/json",
        content_length: 123,
        content_encoding: "gzip",
      }),
    ),
  );
  expect(inspection.completeness.unavailable_sections).toEqual(
    expect.arrayContaining(["network_requests", "json_body_shapes"]),
  );
  expect(
    inspection.completeness.excluded.filter(
      ({ section }) =>
        section === "network_requests" || section === "json_body_shapes",
    ),
  ).toEqual([
    {
      section: "json_body_shapes",
      reason: "invalid_protocol_value",
      count: cases.length,
    },
    {
      section: "network_requests",
      reason: "invalid_protocol_value",
      count: cases.length,
    },
  ]);
  expect(
    browser.commands.filter(
      ({ method }) => method === "Network.getResponseBody",
    ),
  ).toEqual([]);
  const output = JSON.stringify(inspection);
  for (const excluded of [
    "/final",
    "private.example.test",
    "unauthorized-secret",
    "redirect-header-secret",
  ])
    expect(output).not.toContain(excluded);
});

it.each([
  { label: "omitted", status: {}, invalid: false },
  { label: "malformed", status: { status: "302" }, invalid: true },
])(
  "retains scoped network facts when status is $label",
  async ({ status, invalid }) => {
    const phases = [
      "orphan-redirect",
      "observed-redirect",
      "response",
    ] as const;
    const cases = [
      ...phases.map((phase) => ({
        id: phase,
        phase,
        status,
        mime: "text/plain",
      })),
      ...(invalid
        ? [
            {
              id: "fractional",
              phase: "response" as const,
              status: { status: 200.5 },
              mime: "application/json",
            },
          ]
        : []),
    ];
    const { browser, inspection } = await inspectNetwork({
      eventsBeforeReply: ["Network.enable"],
      commandEvents(command, origin) {
        if (command.method !== "Network.enable") return undefined;
        return cases.flatMap(({ id, phase, status, mime }): CdpEvent[] => {
          const priorUrl = `${origin}/${id}/prior`;
          const request = (url: string) => ({
            requestId: id,
            type: "Fetch",
            request: { url, method: "GET" },
            initiator: { type: "other" },
          });
          const response = {
            url: phase === "response" ? `${origin}/${id}/reported` : priorUrl,
            mimeType: mime,
            encodedDataLength: 0,
            headers: { "Content-Length": "123", "Content-Encoding": "gzip" },
            ...status,
          };
          const events: CdpEvent[] = [];
          if (phase !== "orphan-redirect")
            events.push({
              method: "Network.requestWillBeSent",
              sessionId: command.sessionId,
              params: { ...request(priorUrl), timestamp: 1 },
            });
          events.push(
            phase === "response"
              ? {
                  method: "Network.responseReceived",
                  sessionId: command.sessionId,
                  params: { requestId: id, response },
                }
              : {
                  method: "Network.requestWillBeSent",
                  sessionId: command.sessionId,
                  params: {
                    ...request(`${origin}/${id}/final`),
                    timestamp: 2,
                    redirectResponse: response,
                  },
                },
          );
          return events;
        });
      },
    });

    const origin = browser.allowedOrigin;
    expect(inspection.network.requests).toEqual([
      expect.objectContaining({
        request_id: "orphan-redirect",
        url: `${origin}/orphan-redirect/final`,
        redirects: [],
      }),
      expect.objectContaining({
        request_id: "observed-redirect",
        url: `${origin}/observed-redirect/final`,
        redirects: [
          expect.objectContaining({
            response_url: `${origin}/observed-redirect/prior`,
            status: null,
            encoded_data_length: 0,
            request_timestamp: 1,
            redirect_event_timestamp: 2,
          }),
        ],
      }),
      ...cases
        .filter(({ phase }) => phase === "response")
        .map(({ id, mime }) =>
          expect.objectContaining({
            request_id: id,
            url: `${origin}/${id}/prior`,
            status: null,
            mime_type: mime,
            redirects: [],
          }),
        ),
    ]);
    expect(inspection.metadata.responses).toEqual(
      cases
        .filter(({ phase }) => phase === "response")
        .map(({ id, mime }) =>
          expect.objectContaining({
            request_id: id,
            url: `${origin}/${id}/reported`,
            mime_type: mime,
            content_length: 123,
            content_encoding: "gzip",
          }),
        ),
    );
    expect(
      inspection.completeness.excluded.filter(
        ({ section }) => section === "network_requests",
      ),
    ).toEqual(
      invalid
        ? [
            {
              section: "network_requests",
              reason: "invalid_protocol_value",
              count: 4,
            },
          ]
        : [],
    );
  },
);
