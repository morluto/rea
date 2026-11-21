import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import type { CdpEvent } from "../../../src/browser/CdpConnection.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const inspectResponseBodies = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Network.enable", "Network.getResponseBody"],
    ...options,
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
  return { browser, result };
};

interface JsonExchange {
  readonly requestId: string;
  readonly url: string;
  readonly postData?: string;
  readonly status?: number;
  readonly encodedLength?: number;
  readonly redirectResponse?: {
    readonly url: string;
    readonly status: number;
    readonly mimeType: string;
    readonly encodedDataLength: number;
  };
}

const jsonExchange = (
  sessionId: string | undefined,
  {
    requestId,
    url,
    postData,
    status = 200,
    encodedLength,
    redirectResponse,
  }: JsonExchange,
): CdpEvent[] => {
  const session = sessionId === undefined ? {} : { sessionId };
  const request =
    postData === undefined
      ? { url, method: "GET" }
      : {
          url,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          postData,
        };
  const events: CdpEvent[] = [
    {
      ...session,
      method: "Network.requestWillBeSent",
      params: {
        requestId,
        request,
        initiator: { type: "other" },
        ...(redirectResponse === undefined ? {} : { redirectResponse }),
      },
    },
    {
      ...session,
      method: "Network.responseReceived",
      params: {
        requestId,
        response: { url, status, mimeType: "application/json" },
      },
    },
  ];
  if (encodedLength !== undefined)
    events.push({
      ...session,
      method: "Network.loadingFinished",
      params: { requestId, encodedDataLength: encodedLength },
    });
  return events;
};

const responseBodyReads = (browser: FakeCdpBrowser) =>
  browser.commands
    .filter(({ method }) => method === "Network.getResponseBody")
    .map(({ params }) => params.requestId);

const objectShape = expect.objectContaining({ root_type: "object" });

it("preserves unavailable response observations and captures completed peers", async () => {
  const { browser, result } = await inspectResponseBodies({
    commandEvents(command, origin) {
      if (command.method !== "Network.enable") return undefined;
      return ["unfinished", "missing-body", "available"].flatMap((requestId) =>
        jsonExchange(command.sessionId, {
          requestId,
          url: `${origin}/${requestId}`,
          postData: '{"selected":true}',
          ...(requestId === "unfinished" ? {} : { encodedLength: 0 }),
        }),
      );
    },
    commandError(command) {
      if (
        command.method === "Network.getResponseBody" &&
        command.params.requestId === "missing-body"
      )
        return {
          code: -32_000,
          message: "No data found for resource with given identifier",
        };
      return undefined;
    },
    commandResult(command) {
      return command.method === "Network.getResponseBody"
        ? { body: '{"retained":true}', base64Encoded: false }
        : undefined;
    },
  });
  if (!result.ok) throw result.error;
  expect(result.value.network.requests).toEqual([
    expect.objectContaining({
      request_id: "unfinished",
      status: 200,
      encoded_data_length: null,
      body_shapes: { status: "partial", request: objectShape, response: null },
    }),
    expect.objectContaining({
      request_id: "missing-body",
      status: 200,
      encoded_data_length: 0,
      body_shapes: { status: "partial", request: objectShape, response: null },
    }),
    expect.objectContaining({
      request_id: "available",
      body_shapes: {
        status: "included",
        request: objectShape,
        response: objectShape,
      },
    }),
  ]);
  expect(result.value.completeness.unavailable_sections).toContain(
    "json_body_shapes",
  );
  expect(result.value.limitations).toContainEqual(
    expect.stringContaining(
      "missing-body: CDP Network.getResponseBody failed (-32000): No data found",
    ),
  );
  expect(responseBodyReads(browser)).toEqual(["missing-body", "available"]);
});

it("marks JSON response bodies unavailable when their events arrive during body capture", async () => {
  const { browser, result } = await inspectResponseBodies({
    commandEvents(command, origin) {
      if (command.method === "Network.enable")
        return jsonExchange(command.sessionId, {
          requestId: "initial",
          url: `${origin}/initial.json`,
          encodedLength: 16,
        });
      if (
        command.method === "Network.getResponseBody" &&
        command.params.requestId === "initial"
      )
        return jsonExchange(command.sessionId, {
          requestId: "late",
          url: `${origin}/late.json`,
          encodedLength: 14,
        });
      return undefined;
    },
    commandResult(command) {
      return command.method === "Network.getResponseBody"
        ? { body: '{"initial":true}', base64Encoded: false }
        : undefined;
    },
  });
  if (!result.ok) throw result.error;
  expect(result.value.network.requests).toEqual([
    expect.objectContaining({
      request_id: "initial",
      body_shapes: { status: "included", request: null, response: objectShape },
    }),
    expect.objectContaining({
      request_id: "late",
      body_shapes: { status: "unavailable", request: null, response: null },
    }),
  ]);
  expect(responseBodyReads(browser)).toEqual(["initial"]);
  expect(result.value.completeness.unavailable_sections).toContain(
    "json_body_shapes",
  );
});

it("does not attach a redirect response body to the reused request ID", async () => {
  const { browser, result } = await inspectResponseBodies({
    commandEvents(command, origin) {
      const url = `${origin}/before-redirect.json`;
      if (command.method === "Network.enable")
        return jsonExchange(command.sessionId, {
          requestId: "reused",
          url,
          status: 302,
          encodedLength: 12,
        });
      if (
        command.method === "Network.getResponseBody" &&
        command.params.requestId === "reused"
      )
        return jsonExchange(command.sessionId, {
          requestId: "reused",
          url: `${origin}/after-redirect.json`,
          encodedLength: 14,
          redirectResponse: {
            url,
            status: 302,
            mimeType: "application/json",
            encodedDataLength: 12,
          },
        });
      return undefined;
    },
    commandResult(command) {
      return command.method === "Network.getResponseBody"
        ? { body: '{"belongs":"redirect"}', base64Encoded: false }
        : undefined;
    },
  });
  if (!result.ok) throw result.error;
  expect(result.value.network.requests).toEqual([
    expect.objectContaining({
      request_id: "reused",
      url: `${browser.allowedOrigin}/after-redirect.json`,
      redirects: [expect.objectContaining({ status: 302 })],
      body_shapes: { status: "unavailable", request: null, response: null },
    }),
  ]);
  expect(responseBodyReads(browser)).toEqual(["reused"]);
  expect(result.value.completeness.unavailable_sections).toContain(
    "json_body_shapes",
  );
});

it("marks malformed JSON body shapes unavailable while preserving partial request shapes", async () => {
  const { result } = await inspectResponseBodies({
    commandEvents(command, origin) {
      if (command.method !== "Network.enable") return undefined;
      return [
        ...jsonExchange(command.sessionId, {
          requestId: "unavailable",
          url: `${origin}/unavailable`,
          encodedLength: 0,
        }),
        ...jsonExchange(command.sessionId, {
          requestId: "partial",
          url: `${origin}/partial`,
          postData: '{"request":true}',
          encodedLength: 0,
        }),
      ];
    },
    commandResult(command) {
      return command.method === "Network.getResponseBody"
        ? { body: "{", base64Encoded: false }
        : undefined;
    },
  });
  if (!result.ok) throw result.error;
  expect(result.value.network.requests).toEqual([
    expect.objectContaining({
      request_id: "unavailable",
      body_shapes: { status: "unavailable", request: null, response: null },
    }),
    expect.objectContaining({
      request_id: "partial",
      body_shapes: { status: "partial", request: objectShape, response: null },
    }),
  ]);
  expect(result.value.completeness.unavailable_sections).toContain(
    "json_body_shapes",
  );
  expect(
    result.value.completeness.excluded.filter(
      ({ section }) => section === "json_body_shapes",
    ),
  ).toEqual([
    {
      section: "json_body_shapes",
      reason: "provider_unavailable",
      count: null,
    },
  ]);
});

it("rejects malformed response-body envelopes and preserves request shapes", async () => {
  const envelopes: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
    {
      "missing-encoding-flag": { body: '{"response":true}' },
      "invalid-encoding-flag": {
        body: '{"response":true}',
        base64Encoded: "false",
      },
      "invalid-body": { body: 7, base64Encoded: false },
    };
  const { browser, result } = await inspectResponseBodies({
    commandEvents(command, origin) {
      if (command.method !== "Network.enable") return undefined;
      return Object.keys(envelopes).flatMap((requestId) =>
        jsonExchange(command.sessionId, {
          requestId,
          url: `${origin}/${requestId}`,
          ...(requestId === "missing-encoding-flag"
            ? {}
            : { postData: '{"request":true}' }),
          encodedLength: 0,
        }),
      );
    },
    commandResult(command) {
      const id = command.params.requestId;
      return command.method === "Network.getResponseBody" &&
        typeof id === "string"
        ? envelopes[id]
        : undefined;
    },
  });
  if (!result.ok) throw result.error;
  expect(result.value.network.requests).toEqual([
    expect.objectContaining({
      request_id: "missing-encoding-flag",
      body_shapes: { status: "unavailable", request: null, response: null },
    }),
    expect.objectContaining({
      request_id: "invalid-encoding-flag",
      body_shapes: { status: "partial", request: objectShape, response: null },
    }),
    expect.objectContaining({
      request_id: "invalid-body",
      body_shapes: { status: "partial", request: objectShape, response: null },
    }),
  ]);
  expect(responseBodyReads(browser)).toEqual(Object.keys(envelopes));
  expect(
    result.value.completeness.excluded.filter(
      ({ section }) => section === "json_body_shapes",
    ),
  ).toEqual([
    { section: "json_body_shapes", reason: "invalid_protocol_value", count: 3 },
  ]);
  expect(result.value.limitations).toContainEqual(
    expect.stringContaining("Network.getResponseBody"),
  );
});

it("stops body queries when the target lacks the method and preserves all request shapes", async () => {
  const { browser, result } = await inspectResponseBodies({
    unsupportedMethods: ["Network.getResponseBody"],
    commandEvents(command, origin) {
      if (command.method !== "Network.enable") return undefined;
      return ["first", "remaining"].flatMap((requestId) =>
        jsonExchange(command.sessionId, {
          requestId,
          url: `${origin}/${requestId}`,
          postData: '{"request":true}',
          encodedLength: 0,
        }),
      );
    },
  });
  if (!result.ok) throw result.error;
  expect(responseBodyReads(browser)).toEqual(["first"]);
  expect(result.value.network.requests).toEqual(
    ["first", "remaining"].map((request_id) =>
      expect.objectContaining({
        request_id,
        body_shapes: {
          status: "partial",
          request: objectShape,
          response: null,
        },
      }),
    ),
  );
  expect(result.value.completeness.unavailable_sections).toContain(
    "json_body_shapes",
  );
  expect(result.value.limitations).toContainEqual(
    expect.stringContaining("Network.getResponseBody"),
  );
});

it.each([
  {
    options: {
      commandError: (command: { method: string }) =>
        command.method === "Network.getResponseBody"
          ? { code: -32_602, message: "Invalid parameters" }
          : undefined,
    },
    reason: "protocol_error",
  },
  {
    options: { malformedMessageOnMethod: "Network.getResponseBody" },
    reason: "protocol_error",
  },
  {
    options: { closeOnMethod: "Network.getResponseBody" },
    reason: "disconnected",
  },
])(
  "preserves fatal response capture errors ($reason)",
  async ({ options, reason }) => {
    const { result } = await inspectResponseBodies(options);
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason },
    });
  },
);

it("keeps malformed requests and empty identities out of the passive inventory", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Network.enable"],
    commandEvents(command, origin) {
      if (command.method !== "Network.enable") return undefined;
      const request = (
        requestId: string,
        request: unknown,
        initiator: unknown,
      ) => ({
        sessionId: command.sessionId,
        method: "Network.requestWillBeSent",
        params: { requestId, request, initiator },
      });
      const script = { type: "script" };
      const emptyUrl = `${origin}/empty-id`;
      return [
        request(
          "valid",
          { url: `${origin}/valid`, method: "GET" },
          { type: "future-protocol-type" },
        ),
        request("missing-method", { url: `${origin}/missing-method` }, script),
        request(
          "empty-method",
          { url: `${origin}/empty-method`, method: "" },
          script,
        ),
        request(
          "missing-initiator-type",
          { url: `${origin}/missing-initiator-type`, method: "POST" },
          {},
        ),
        request("missing-request", null, script),
        request("", { url: emptyUrl, method: "GET" }, script),
        {
          sessionId: command.sessionId,
          method: "Network.responseReceived",
          params: {
            requestId: "",
            response: { url: emptyUrl, status: 200, mimeType: "text/html" },
          },
        },
        {
          sessionId: command.sessionId,
          method: "Network.loadingFinished",
          params: { requestId: "", encodedDataLength: 42 },
        },
      ];
    },
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.network.requests).toEqual([
    expect.objectContaining({
      request_id: "valid",
      url: `${browser.allowedOrigin}/valid`,
      method: "GET",
      status: null,
      encoded_data_length: null,
      initiator: expect.objectContaining({ type: "future-protocol-type" }),
    }),
  ]);
  expect(result.value.metadata.responses).toEqual([]);
  expect(
    result.value.completeness.excluded.filter(
      ({ section }) => section === "network_requests",
    ),
  ).toEqual([
    { section: "network_requests", reason: "invalid_protocol_value", count: 6 },
  ]);
});

describe("malformed reused CDP request IDs", () => {
  it("keeps the last valid request and redirects after a malformed replacement", async () => {
    const browser = await startFakeCdpBrowser({
      commandEvents(command, origin) {
        if (command.method !== "Network.enable") return undefined;
        const session =
          command.sessionId === undefined
            ? {}
            : { sessionId: command.sessionId };
        return [
          {
            ...session,
            method: "Network.requestWillBeSent",
            params: {
              requestId: "redirecting",
              request: { url: `${origin}/first`, method: "POST" },
              initiator: { type: "parser" },
            },
          },
          {
            ...session,
            method: "Network.requestWillBeSent",
            params: {
              requestId: "redirecting",
              request: { url: `${origin}/second`, method: "GET" },
              initiator: { type: "other" },
              redirectResponse: {
                url: `${origin}/first`,
                status: 301,
                mimeType: "text/plain",
                encodedDataLength: 12,
              },
            },
          },
          {
            ...session,
            method: "Network.responseReceived",
            params: {
              requestId: "redirecting",
              response: {
                url: `${origin}/second`,
                status: 202,
                mimeType: "application/json",
              },
            },
          },
          {
            ...session,
            method: "Network.requestWillBeSent",
            params: {
              requestId: "redirecting",
              request: { url: `${origin}/third` },
              initiator: { type: "other" },
              redirectResponse: {
                url: `${origin}/second`,
                status: 302,
                mimeType: "text/plain",
                encodedDataLength: 18,
              },
            },
          },
          {
            ...session,
            method: "Network.responseReceived",
            params: {
              requestId: "redirecting",
              response: {
                url: `${origin}/third`,
                status: 418,
                mimeType: "application/json",
              },
            },
          },
          {
            ...session,
            method: "Network.loadingFinished",
            params: { requestId: "redirecting", encodedDataLength: 777 },
          },
        ];
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
    expect(result.value.network.requests).toEqual([
      expect.objectContaining({
        request_id: "redirecting",
        url: `${browser.allowedOrigin}/second`,
        method: "GET",
        status: 202,
        mime_type: "application/json",
        encoded_data_length: null,
        redirects: [
          expect.objectContaining({
            url: `${browser.allowedOrigin}/first`,
            response_url: `${browser.allowedOrigin}/first`,
            method: "POST",
            status: 301,
          }),
        ],
      }),
    ]);
    expect(result.value.completeness.excluded).toContainEqual({
      section: "network_requests",
      reason: "invalid_protocol_value",
      count: 1,
    });
    expect(result.value.completeness.excluded).toContainEqual({
      section: "json_body_shapes",
      reason: "invalid_protocol_value",
      count: 1,
    });
    expect(
      browser.commands.filter(
        ({ method }) => method === "Network.getResponseBody",
      ),
    ).toEqual([]);
  });
});

describe("CDP network length metadata", () => {
  it("retains valid zero lengths and excludes malformed loading lengths", async () => {
    const browser = await startFakeCdpBrowser({
      commandEvents(command, origin) {
        if (command.method !== "Network.enable") return undefined;
        const session =
          command.sessionId === undefined
            ? {}
            : { sessionId: command.sessionId };
        const request = (requestId: string, path: string) => ({
          ...session,
          method: "Network.requestWillBeSent",
          params: {
            requestId,
            request: { url: `${origin}${path}`, method: "GET" },
            initiator: { type: "parser" },
          },
        });
        return [
          request("zero", "/zero"),
          request("missing", "/missing"),
          request("negative", "/negative"),
          request("prior", "/prior"),
          request("redirect-zero", "/redirect-zero-first"),
          request("redirect-invalid", "/redirect-invalid-first"),
          {
            ...session,
            method: "Network.loadingFinished",
            params: { requestId: "zero", encodedDataLength: 0 },
          },
          {
            ...session,
            method: "Network.loadingFinished",
            params: { requestId: "missing" },
          },
          {
            ...session,
            method: "Network.loadingFinished",
            params: { requestId: "negative", encodedDataLength: -1 },
          },
          {
            ...session,
            method: "Network.loadingFinished",
            params: { requestId: "prior", encodedDataLength: 27 },
          },
          {
            ...session,
            method: "Network.loadingFinished",
            params: { requestId: "prior", encodedDataLength: -1 },
          },
          {
            ...session,
            method: "Network.requestWillBeSent",
            params: {
              requestId: "redirect-zero",
              request: { url: `${origin}/redirect-zero-final`, method: "GET" },
              initiator: { type: "parser" },
              redirectResponse: {
                url: `${origin}/redirect-zero-first`,
                status: 301,
                encodedDataLength: 0,
              },
            },
          },
          {
            ...session,
            method: "Network.requestWillBeSent",
            params: {
              requestId: "redirect-invalid",
              request: {
                url: `${origin}/redirect-invalid-final`,
                method: "GET",
              },
              initiator: { type: "parser" },
              redirectResponse: {
                url: `${origin}/redirect-invalid-first`,
                status: 301,
                encodedDataLength: -1,
              },
            },
          },
        ];
      },
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    const requests = new Map(
      result.value.network.requests.map((item) => [item.request_id, item]),
    );
    expect(requests.get("zero")?.encoded_data_length).toBe(0);
    expect(requests.get("missing")?.encoded_data_length).toBeNull();
    expect(requests.get("negative")?.encoded_data_length).toBeNull();
    expect(requests.get("prior")?.encoded_data_length).toBe(27);
    expect(
      requests.get("redirect-zero")?.redirects?.[0]?.encoded_data_length,
    ).toBe(0);
    expect(
      requests.get("redirect-invalid")?.redirects?.[0]?.encoded_data_length,
    ).toBeNull();
    expect(result.value.completeness.excluded).toContainEqual({
      section: "network_requests",
      reason: "invalid_protocol_value",
      count: 4,
    });
  });
});

const scopedRedirectEvents: NonNullable<FakeOptions["commandEvents"]> = (
  command,
  origin,
) => {
  if (command.method !== "Network.enable") return undefined;
  const request = (
    requestId: string,
    url: string,
    method: string,
    timestamp: number,
    redirectResponse?: Record<string, unknown>,
  ) => ({
    sessionId: command.sessionId,
    method: "Network.requestWillBeSent",
    params: {
      requestId,
      type: "Fetch",
      request: { url, method },
      initiator: { type: "other" },
      timestamp,
      ...(redirectResponse === undefined ? {} : { redirectResponse }),
    },
  });
  const response = (requestId: string, url: string) => ({
    sessionId: command.sessionId,
    method: "Network.responseReceived",
    params: {
      requestId,
      response: { url, status: 200, mimeType: "text/plain" },
    },
  });
  const original = `${origin}/api?token=network-secret`;
  const intermediate = `${origin}/intermediate`;
  const finalUrl = `${origin}/redirected?token=final-secret`;
  return [
    request("inside", original, "POST", 7),
    request("inside", intermediate, "GET", 8, {
      url: original,
      status: 301,
      mimeType: "text/plain",
      encodedDataLength: 23,
      headers: { "X-Private": "redirect-header-secret" },
    }),
    request("inside", finalUrl, "GET", 9, {
      url: intermediate,
      status: 302,
      mimeType: "text/plain",
      encodedDataLength: 27,
    }),
    response("inside", finalUrl),
    request("outbound", `${origin}/leaving`, "POST", 10),
    // The continuation alone must retire the prior row. A terminal
    // response could independently discard it and hide that failure.
    request("outbound", "https://private.example.test/redirected", "GET", 11, {
      url: `${origin}/leaving`,
      status: 302,
      mimeType: "text/plain",
      encodedDataLength: 23,
    }),
    request(
      "returning",
      "https://private.example.test/start?token=initial-url-secret",
      "POST",
      12,
    ),
    request("returning", `${origin}/returned`, "GET", 13, {
      url: "https://private.example.test/outside?token=redirect-url-secret",
      status: 302,
      mimeType: "text/plain",
      encodedDataLength: 31,
      headers: { "X-Private": "redirect-header-secret" },
      postData: "redirect-body-secret",
    }),
    response("returning", `${origin}/returned`),
  ];
};

it("retains redirect hops only while their requests remain in scope", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Network.enable"],
    commandEvents: scopedRedirectEvents,
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );

  if (!result.ok) throw result.error;
  const origin = browser.allowedOrigin;
  const redirected = `${origin}/redirected?token=final-secret`;
  const returned = `${origin}/returned`;
  expect(result.value.network.requests).toEqual([
    expect.objectContaining({
      request_id: "inside",
      url: redirected,
      status: 200,
      redirects: [
        {
          url: `${origin}/api?token=network-secret`,
          response_url: `${origin}/api?token=network-secret`,
          method: "POST",
          resource_type: "Fetch",
          status: 301,
          mime_type: "text/plain",
          encoded_data_length: 23,
          request_timestamp: 7,
          redirect_event_timestamp: 8,
          response_source: {
            service_worker: null,
            disk_cache: null,
            service_worker_response_source: null,
          },
        },
        {
          url: `${origin}/intermediate`,
          response_url: `${origin}/intermediate`,
          method: "GET",
          resource_type: "Fetch",
          status: 302,
          mime_type: "text/plain",
          encoded_data_length: 27,
          request_timestamp: 8,
          redirect_event_timestamp: 9,
          response_source: {
            service_worker: null,
            disk_cache: null,
            service_worker_response_source: null,
          },
        },
      ],
    }),
    expect.objectContaining({
      request_id: "returning",
      url: returned,
      status: 200,
      redirects: [],
    }),
  ]);
  expect(
    result.value.metadata.responses.map(({ request_id, url }) => [
      request_id,
      url,
    ]),
  ).toEqual([
    ["inside", redirected],
    ["returning", returned],
  ]);
  const output = JSON.stringify({
    requests: result.value.network.requests,
    responses: result.value.metadata.responses,
  });
  for (const excluded of [
    "private.example.test",
    "redirect-header-secret",
    "redirect-body-secret",
  ])
    expect(output).not.toContain(excluded);
  expect(result.value.completeness).toMatchObject({
    status: "policy_filtered",
  });
  expect(result.value.completeness.policy_filtered_sections).toContain(
    "network_requests",
  );
  expect(result.value.completeness.unavailable_sections).not.toContain(
    "network_requests",
  );
  expect(
    result.value.completeness.excluded.filter(
      ({ section }) => section === "network_requests",
    ),
  ).toEqual([
    { section: "network_requests", reason: "disallowed_origin", count: 3 },
  ]);
});
