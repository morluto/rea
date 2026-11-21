import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page, Request, Response } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { resolveScenarioSecrets } from "../../tests/fixtures/browserScenarioSecrets.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";

describe("declared secrets in scenario events", () => {
  it("redacts encoded declared secrets from text evidence and fingerprints", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const socketListeners = new Map<string, (value: unknown) => void>();
    const page = {
      on: (name: string, listener: (value: unknown) => void) => {
        listeners.set(name, listener);
      },
    } as unknown as Page;
    const secret = "a/b&c\n d";
    const scenario = browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: "/opt/chromium" },
      start_url: { url: "https://app.example.test/" },
      actions: [
        { step_id: "wait", action: "wait_for_timeout", duration_ms: 1 },
      ],
      secrets: [
        { secret_id: "login_input", environment_variable: "REA_TEST_TOKEN" },
      ],
      capture: { events: ["console", "page-errors", "websockets"] },
    });
    const secrets = resolveScenarioSecrets(scenario, {
      REA_TEST_TOKEN: secret,
    });
    const events = new PlaywrightScenarioEvents({
      page,
      enabled: new Set(["console", "page-errors", "websockets"]),
      secrets,
    });

    listeners.get("console")?.({
      type: () => "log",
      text: () => encodeURIComponent(secret),
      location: () => ({ url: "https://app.example.test/app.js" }),
    });
    const escapedSecret = JSON.stringify(secret).slice(1, -1);
    const error = new Error(`failure ${escapedSecret}`);
    error.stack = `failure ${escapedSecret}`;
    listeners.get("pageerror")?.(error);
    listeners.get("websocket")?.({
      url: () => "wss://app.example.test/socket",
      on: (name: string, listener: (value: unknown) => void) => {
        socketListeners.set(name, listener);
      },
    });
    const formEncodedSecret = new URLSearchParams([["value", secret]])
      .toString()
      .slice("value=".length);
    socketListeners.get("framesent")?.({ payload: formEncodedSecret });

    const items = events.result().items;
    expect(items).toMatchObject([
      { kind: "console", text: "[REDACTED:login_input]" },
      {
        kind: "page-error",
        message: "failure [REDACTED:login_input]",
        stack: "failure [REDACTED:login_input]",
      },
      { kind: "websocket-opened" },
      {
        kind: "websocket-frame-sent",
        payload_text: "[REDACTED:login_input]",
      },
    ]);
    expect(secrets.fingerprint(`stored ${encodeURIComponent(secret)}`)).toEqual(
      { value_state: "redacted-secret", value_sha256: null },
    );
  });
});

const captureNetworkBudgetFixture = async (
  maxTotalEventAllocationBytes?: number,
) => {
  const context = new EventEmitter();
  const page = new EventEmitter();
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/fixture/chrome" },
    start_url: { url: "http://127.0.0.1/fixture" },
    actions: [{ step_id: "ready", action: "wait_for_timeout", duration_ms: 1 }],
    capture: {
      events: ["network"],
      network: { response_body: true },
      ...(maxTotalEventAllocationBytes === undefined
        ? {}
        : {
            limits: {
              max_total_event_allocation_bytes: maxTotalEventAllocationBytes,
            },
          }),
    },
  });
  const secrets = resolveScenarioSecrets(scenario, {});
  const redactBytes = vi.spyOn(secrets, "redactBytes");
  const redactJson = vi.spyOn(secrets, "redactJsonBody");
  const capture = new PlaywrightScenarioEvents({
    page: page as unknown as Page,
    context: context as unknown as BrowserContext,
    ownsContext: true,
    enabled: new Set(["network"]),
    network: scenario.capture.network,
    limits: scenario.capture.limits,
    secrets,
  });
  const largeBody = Buffer.from("x".repeat(60_000));
  const smallBody = Buffer.from('{"ok":true}');
  for (let index = 0; index < 43; index += 1) {
    const post = index >= 40;
    const body = post ? smallBody : largeBody;
    const request = {
      method: () => (post ? "POST" : "GET"),
      url: () => `http://127.0.0.1/${post ? "final" : "data"}/${String(index)}`,
      resourceType: () => "fetch",
      postDataBuffer: () => (post ? Buffer.from("{}") : null),
      redirectedFrom: () => null,
      failure: () => null,
      headers: () => ({ "content-type": "application/json" }),
      headersArray: async () => [
        { name: "content-type", value: "application/json" },
      ],
    } as unknown as Request;
    const response = {
      request: () => request,
      url: () => request.url(),
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      headersArray: async () => [
        { name: "content-type", value: "application/json" },
      ],
      body: async () => body,
    } as unknown as Response;
    context.emit("request", request);
    context.emit("response", response);
    context.emit("requestfinished", request);
    await vi.advanceTimersByTimeAsync(0);
  }
  await capture.finish();
  return {
    result: capture.result(),
    redactedBodies: redactBytes.mock.calls.filter(
      ([bytes]) =>
        bytes.length === largeBody.length || bytes.length === smallBody.length,
    ).length,
    processedJsonBodies: redactJson.mock.calls.length,
  };
};

it("identifies omitted network transaction content and honors a raised budget", async () => {
  vi.useFakeTimers();
  try {
    const baseline = await captureNetworkBudgetFixture();
    const raised = await captureNetworkBudgetFixture(32 * 1024 * 1024);
    expect(baseline.result.dropped).toBeGreaterThan(0);
    expect(
      baseline.result.omissions.by_kind.find(
        ({ kind }) => kind === "network-content",
      ),
    ).toMatchObject({
      count: expect.any(Number),
      reasons: expect.arrayContaining(["max-total-event-allocation-bytes"]),
    });
    expect(
      baseline.result.omissions.network_transactions.length,
    ).toBeGreaterThan(0);
    const retainedBodies = baseline.result.items.filter(
      (event) =>
        event.kind === "network-content" && event.body.state === "captured",
    ).length;
    expect(baseline.processedJsonBodies).toBe(retainedBodies);
    expect(baseline.redactedBodies).toBe(retainedBodies);
    expect(raised.result).toMatchObject({
      dropped: 0,
      omissions: { network_transactions: [] },
    });
    expect(
      raised.result.items.filter(
        (event) =>
          event.kind === "network-content" && event.phase === "response",
      ),
    ).toHaveLength(43);
  } finally {
    vi.useRealTimers();
  }
});

it("retains network response events with HTTP status codes above 599 without error", () => {
  const contextListeners = new Map<string, (value: unknown) => void>();
  const context = {
    on: (name: string, listener: (value: unknown) => void) => {
      contextListeners.set(name, listener);
    },
    off: () => {},
  } as unknown as BrowserContext;
  const page = {
    url: () => "https://app.example.test/",
    context: () => context,
    on: () => {},
  } as unknown as Page;
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium" },
    start_url: { url: "https://app.example.test/" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
    capture: { events: ["network"] },
  });
  const secrets = resolveScenarioSecrets(scenario, {});
  const events = new PlaywrightScenarioEvents({
    page,
    context,
    enabled: new Set(["network"]),
    secrets,
  });
  const request = {
    url: () => "https://app.example.test/api/check",
    method: () => "GET",
    resourceType: () => "xhr",
    postDataBuffer: () => null,
    redirectedFrom: () => null,
    failure: () => null,
    headers: () => ({}),
    headersArray: async () => [],
    frame: () => ({ page: () => page }),
  } as unknown as Request;
  const response = {
    request: () => request,
    url: () => request.url(),
    status: () => 999,
    headers: () => ({ "content-type": "text/plain" }),
    headersArray: async () => [{ name: "content-type", value: "text/plain" }],
    body: async () => Buffer.from("denied"),
  } as unknown as Response;

  contextListeners.get("request")?.(request);
  expect(() => contextListeners.get("response")?.(response)).not.toThrow();
  const items = events.result().items;
  const responseEvent = items.find((e) => e.kind === "response");
  expect(responseEvent).toBeDefined();
  expect(responseEvent).toMatchObject({
    kind: "response",
    status: 999,
    url: { url: "https://app.example.test/api/check" },
  });
});

it("keeps admitted page errors intact and reports each distinct event budget", async () => {
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium" },
    start_url: { url: "https://app.example.test/" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  const secrets = resolveScenarioSecrets(scenario, {});
  const captureErrors = (
    page: EventEmitter,
    maxTotal = scenario.capture.limits.max_total_event_allocation_bytes,
  ) =>
    new PlaywrightScenarioEvents({
      page: page as unknown as Page,
      enabled: new Set(["page-errors"]),
      limits: {
        ...scenario.capture.limits,
        max_total_event_allocation_bytes: maxTotal,
      },
      secrets,
    });
  const emit = (page: EventEmitter, message: string, stack = "") => {
    const error = new Error(message);
    error.stack = stack;
    page.emit("pageerror", error);
  };
  const page = new EventEmitter();
  const capture = captureErrors(page);
  const message = "m".repeat(70_000);
  const stack = "s".repeat(300_000);
  emit(page, message, stack);
  const redact = vi.spyOn(secrets, "redact");
  emit(page, "x".repeat(1_000_000));
  expect(redact).not.toHaveBeenCalled();

  for (let index = 1; index < 10_000; index += 1)
    emit(page, `ordinary-${index}`);
  emit(page, "over count");
  await capture.finish();
  const result = capture.result();
  expect(result).toMatchObject({
    retained: 10_000,
    dropped: 2,
    omissions: {
      by_kind: [
        {
          kind: "page-error",
          count: 2,
          reasons: ["max-event-allocation-bytes", "max-events"],
        },
      ],
    },
  });
  expect(result.items[0]).toMatchObject({ kind: "page-error", message, stack });
  expect(result.items.at(-1)).toMatchObject({
    message: "ordinary-9999",
    sequence: 10_001,
  });

  const totalPage = new EventEmitter();
  const total = captureErrors(totalPage, 40_000);
  emit(totalPage, "before excess text");
  redact.mockClear();
  emit(totalPage, "x".repeat(5_000));
  expect(redact).not.toHaveBeenCalled();
  emit(totalPage, "small event remains eligible");
  await total.finish();
  expect(total.result()).toMatchObject({
    retained: 2,
    dropped: 1,
    items: [
      { message: "before excess text", sequence: 1 },
      { message: "small event remains eligible", sequence: 3 },
    ],
    omissions: {
      by_kind: [
        {
          kind: "page-error",
          count: 1,
          reasons: ["max-total-event-allocation-bytes"],
        },
      ],
    },
  });
});

it("reuses a released listener slot after reporting the live owner limit", async () => {
  const { capture, page } = textEventCapture(new Set(["websockets"]));
  const socket = () =>
    Object.assign(new EventEmitter(), { url: () => "wss://example.test/" });
  const admitted = Array.from({ length: 2047 }, socket);
  for (const source of admitted) page.emit("websocket", source);
  const rejected = socket();
  page.emit("websocket", rejected);
  expect(admitted.at(-1)?.listenerCount("close")).toBe(1);
  expect(rejected.eventNames()).toEqual([]);
  expect(capture.result()).toMatchObject({
    retained: 2047,
    dropped: 1,
    omissions: {
      by_kind: [
        {
          kind: "websocket-opened",
          count: 1,
          reasons: ["max-listener-owners"],
        },
      ],
    },
  });

  const first = admitted[0]!;
  first.emit("close");
  expect(first.eventNames()).toEqual([]);
  const replacement = socket();
  page.emit("websocket", replacement);
  expect(replacement.listenerCount("close")).toBe(1);
  expect(capture.result().items.slice(-2)).toMatchObject([
    { kind: "websocket-closed", sequence: 2049 },
    { kind: "websocket-opened", sequence: 2050 },
  ]);
  await capture.finish();
  expect(replacement.eventNames()).toEqual([]);
});

interface SourceTransactionCaptureOptions {
  fail?: boolean;
  followup?: boolean;
  metadataOnly?: boolean;
  learnDirect?: boolean;
  latePageValue?: string;
  value?: string;
  padding?: number;
  metadataLimit?: number;
  requestContent?: { mediaType: string; body: string; typeSecret: string };
}

/** Emit the request before attaching the source policy, matching Playwright listener order. */
const sourceTransactionCapture = async (
  options: SourceTransactionCaptureOptions = {},
) => {
  const listeners = new Map<string, (value: unknown) => void>();
  const context = {
    on: (name: string, listener: (value: unknown) => void) =>
      listeners.set(name, listener),
    off: vi.fn(),
  } as unknown as BrowserContext;
  const page = {
    context: () => context,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Page;
  const value = options.value ?? "credential-82ea";
  const url = `https://example.test/exchange?token=${value.repeat(options.padding ?? 1)}&safe=visible`;
  const body = JSON.stringify({
    token: value,
    ...(options.latePageValue === undefined
      ? {}
      : { page: options.latePageValue }),
    public: "kept",
  });
  const parsed = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/fixture/browser" },
    start_url: { url: "https://example.test/" },
    actions: [{ step_id: "click", action: "wait_for_timeout", duration_ms: 1 }],
    capture: {
      events: ["network"],
      network: {
        request_body: !options.metadataOnly,
        response_body: !options.metadataOnly,
        header_values: !options.metadataOnly,
      },
      ...(options.metadataLimit === undefined
        ? {}
        : {
            limits: {
              max_network_metadata_allocation_bytes: options.metadataLimit,
            },
          }),
    },
  });
  const secrets = resolveScenarioSecrets(parsed, {});
  if (options.requestContent !== undefined)
    secrets.save(
      "earlier.media",
      "media",
      options.requestContent.typeSecret,
      true,
    );
  const mediaType = options.requestContent?.mediaType ?? "application/json";
  const capture = new PlaywrightScenarioEvents({
    page,
    context,
    ownsContext: true,
    enabled: new Set(["network"]),
    network: parsed.capture.network,
    limits: parsed.capture.limits,
    secrets,
  });
  const request = {
    method: () => "POST",
    url: () => url,
    resourceType: () => "fetch",
    redirectedFrom: () => null,
    postDataBuffer: () => Buffer.from(options.requestContent?.body ?? body),
    failure: () => null,
    sizes: async () => ({ responseBodySize: Buffer.byteLength(body) }),
    headers: () => ({
      "content-type": mediaType,
      "x-source-token": value,
    }),
    headersArray: async () => [
      { name: "Content-Type", value: mediaType },
      { name: "X-Source-Token", value },
    ],
  };
  listeners.get("request")!(request);
  if (!options.metadataOnly) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(capture.result().items).toContainEqual(
      expect.objectContaining({ kind: "network-content", phase: "request" }),
    );
  }
  if (options.latePageValue !== undefined)
    secrets.admitPageValue("later.cookie", options.latePageValue);
  const sourceId = capture
    .result()
    .items.find((event) => event.kind === "request")!.transaction_id;
  // This same-URL transaction has no source policy; unknown source values must not withhold it.
  const unrelated = { ...request };
  listeners.get("request")!(unrelated);
  listeners.get("requestfinished")!(unrelated);
  secrets.responseProtector("click", [
    { name: "token", json_pointer: "/token", secret: true },
  ])?.(request);
  if (options.learnDirect)
    secrets.responseProtector("click", [
      { name: "token", json_pointer: "/token", secret: true },
    ])?.(unrelated);
  listeners.get("response")!({
    request: () => request,
    url: () => url,
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    headersArray: async () => [],
    body: async () => {
      if (options.fail) throw new Error(`Read failed for ${url}`);
      return Buffer.from(body);
    },
  });
  if (options.followup) {
    const followup = {
      ...request,
      url: () => `https://example.test/followup?token=${value}`,
    };
    listeners.get("request")!(followup);
    listeners.get("response")!({
      request: () => followup,
      url: () => followup.url(),
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      headersArray: async () => [{ name: "X-Followup", value }],
      body: async () => Buffer.from(body),
    });
    listeners.get("requestfinished")!(followup);
    if (!options.metadataOnly) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capture.result().items).toContainEqual(
        expect.objectContaining({ kind: "network-content", phase: "response" }),
      );
    }
  }
  if (options.learnDirect) secrets.save("click.token", "token", value, true);
  listeners.get("requestfinished")!(request);
  await capture.finish();
  return { capture, sourceId, value, url };
};

it("keeps byte redaction for a hidden binary declaration during the final privacy pass", async () => {
  const typeSecret = "marked-media-parameter";
  const { capture, sourceId } = await sourceTransactionCapture({
    learnDirect: true,
    value: "1000",
    requestContent: {
      mediaType: 'application/octet-stream; note="' + typeSecret + '"',
      typeSecret,
      body: '{"code":1e3,"literal":"1000"}',
    },
  });
  const request = capture
    .result()
    .items.find(
      (event) =>
        event.kind === "network-content" &&
        event.phase === "request" &&
        event.transaction_id === sourceId,
    );
  if (request?.kind !== "network-content" || request.body.state !== "captured")
    throw new Error("Expected captured request bytes");
  expect(request.body.media_type).toBeNull();
  expect(request.body.redacted).toBe(true);
  const text = Buffer.from(request.body.content, "base64").toString("utf8");
  expect(text).toContain('"code":1e3');
  expect(text).not.toContain("1000");
});

it.each([false, true])(
  "finalizes earlier source data with a failed marked response: %s",
  async (fail) => {
    const { capture, sourceId, value } = await sourceTransactionCapture({
      fail,
    });
    const result = capture.result();
    const source = result.items.filter(
      (event) => "transaction_id" in event && event.transaction_id === sourceId,
    );
    expect(JSON.stringify(source)).not.toContain(value);
    expect(source.find(({ kind }) => kind === "request")).toMatchObject({
      url: fail
        ? { url: "", origin: null, query_parameter_names: [], redacted: true }
        : {
            origin: "https://example.test",
            query_parameter_names: ["token", "safe"],
            redacted: true,
            url: expect.stringContaining("safe=visible"),
          },
    });
    expect(
      result.items.find(
        (event) =>
          event.kind === "request" && event.transaction_id !== sourceId,
      ),
    ).toMatchObject({
      url: {
        origin: "https://example.test",
        redacted: !fail,
        url: expect.stringContaining("safe=visible"),
      },
    });

    const content = source.filter((event) => event.kind === "network-content");
    expect(content.map(({ phase }) => phase).sort()).toEqual([
      "request",
      "response",
    ]);
    for (const { body } of content) {
      if (fail) {
        expect(body).toMatchObject({
          state: "unavailable",
          reason: "body-read-failed",
        });
      } else {
        if (body.state !== "captured") throw new Error("Missing source bytes");
        expect(
          JSON.parse(Buffer.from(body.content, "base64").toString()),
        ).toEqual({
          token: "[REDACTED:page:click.token]",
          public: "kept",
        });
      }
    }
    if (fail)
      expect(capture.limitations()).toContainEqual(
        expect.stringContaining("marked response values were unavailable"),
      );
    const finished = JSON.stringify(capture.result());
    await capture.finish();
    expect(JSON.stringify(capture.result())).toBe(finished);
  },
);

it("accounts for source metadata redaction expansion before publishing replacements", async () => {
  const { capture, sourceId } = await sourceTransactionCapture({
    value: "a",
    padding: 1000,
    metadataLimit: 50_000,
  });
  expect(capture.result().omissions.network_transactions).toContainEqual(
    expect.objectContaining({
      transaction_id: sourceId,
      reasons: expect.arrayContaining([
        "max-network-metadata-allocation-bytes",
      ]),
    }),
  );
});

it.each([false, true])(
  "protects a previously recorded follow-up after learning a response secret (metadata only: %s)",
  async (metadataOnly) => {
    const { capture, value } = await sourceTransactionCapture({
      followup: true,
      metadataOnly,
      learnDirect: metadataOnly,
    });
    const { items } = capture.result();
    const followup = items.find(
      (event) =>
        event.kind === "request" && event.url.url.includes("/followup?"),
    );
    if (followup?.kind !== "request")
      throw new Error("Missing follow-up request");
    expect(followup.url).toMatchObject({
      redacted: true,
      origin: "https://example.test",
    });
    expect(JSON.stringify(items)).not.toContain(value);
    const content = items.filter(
      (event) =>
        event.kind === "network-content" &&
        event.transaction_id === followup.transaction_id,
    );
    if (metadataOnly) {
      expect(items.some(({ kind }) => kind === "network-content")).toBe(false);
    } else {
      expect(content).toHaveLength(2);
      expect(content).toContainEqual(
        expect.objectContaining({
          phase: "response",
          headers: {
            state: "captured",
            items: [
              {
                name: "X-Followup",
                value: "[REDACTED:page:click.token]",
                redacted: true,
              },
            ],
          },
        }),
      );
      for (const event of content) {
        if (event.kind !== "network-content" || event.body.state !== "captured")
          throw new Error("Missing follow-up bytes");
        const body = Buffer.from(event.body.content, "base64").toString();
        expect(JSON.parse(body)).toEqual({
          token: "[REDACTED:page:click.token]",
          public: "kept",
        });
      }
    }
  },
);

const textEventCapture = (
  enabled: ConstructorParameters<typeof PlaywrightScenarioEvents>[0]["enabled"],
  maxAllocation?: number,
) => {
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/fixture/browser" },
    start_url: { url: "https://example.test/" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
    capture: { limits: { max_event_allocation_bytes: maxAllocation } },
  });
  const secrets = resolveScenarioSecrets(scenario, {});
  const page = new EventEmitter();
  const capture = new PlaywrightScenarioEvents({
    page: page as unknown as Page,
    enabled,
    limits: scenario.capture.limits,
    secrets,
  });
  return { capture, page, secrets };
};

const consoleMessage = (text: string, url = "") => ({
  type: () => "log",
  text: () => text,
  location: () => ({ url }),
});

it("retains each non-network receipt with its response secret redacted", async () => {
  const { capture, page, secrets } = textEventCapture(
    new Set([
      "console",
      "page-errors",
      "websockets",
      "frames",
      "workers",
      "popups",
      "downloads",
    ]),
  );
  const value = "late-secret-829a";
  const suffix = `example.test/?token=${value}&visible=kept`;
  const url = `https://${suffix}`;
  const source = (sourceUrl: string) =>
    Object.assign(new EventEmitter(), { url: () => sourceUrl });
  const socket = source(`wss://${suffix}`);
  page.emit("console", consoleMessage(value, url));
  const error = new Error(value);
  error.stack = value;
  page.emit("pageerror", error);
  page.emit("websocket", socket);
  socket.emit("framesent", { payload: value });
  page.emit("framenavigated", { url: () => url, name: () => value });
  page.emit("worker", source(url));
  page.emit("popup", source(url));
  page.emit("download", {
    url: () => url,
    suggestedFilename: () => value,
    cancel: async () => undefined,
  });
  expect(capture.result().items[0]).toMatchObject({ text: value });

  secrets.save("late.token", "token", value, true);
  await capture.finish();
  const marker = "[REDACTED:page:late.token]";
  const knownUrl = (origin: string) => ({
    origin,
    query_parameter_names: ["token", "visible"],
    redacted: true,
    url: expect.stringContaining("visible=kept"),
  });
  const http = knownUrl("https://example.test");
  const ws = knownUrl("wss://example.test");
  expect(capture.result().items).toMatchObject([
    { kind: "console", text: marker, url: http },
    { kind: "page-error", message: marker, stack: marker },
    { kind: "websocket-opened", url: ws },
    {
      kind: "websocket-frame-sent",
      payload_text: marker,
      payload_bytes: Buffer.byteLength(value),
      url: ws,
    },
    { kind: "frame-navigated", name: marker, url: http },
    { kind: "worker-created", url: http },
    { kind: "popup-opened", url: http },
    { kind: "download-cancelled", suggested_filename: marker, url: http },
  ]);
  expect(JSON.stringify(capture.result().items)).not.toContain(value);
});

it("reports late redaction overflow once and preserves an unaffected receipt", async () => {
  const { capture, page, secrets } = textEventCapture(
    new Set(["console"]),
    20_000,
  );
  page.emit("console", consoleMessage("x".repeat(1000)));
  page.emit("console", consoleMessage("safe"));
  expect(capture.result().retained).toBe(2);
  secrets.save("late.token", "token", "x", true);
  await capture.finish();
  const result = capture.result();
  expect(result).toMatchObject({
    retained: 1,
    dropped: 1,
    items: [{ kind: "console", text: "safe", sequence: 2 }],
    omissions: {
      by_kind: [
        { kind: "console", count: 1, reasons: ["max-event-allocation-bytes"] },
      ],
      network_transactions: [],
    },
  });
  const finished = JSON.stringify(result);
  await capture.finish();
  expect(JSON.stringify(capture.result())).toBe(finished);
});

it.each(["page", "basic"])(
  "preserves earlier %s facts while applying each redaction scope",
  async (kind) => {
    const fromPage = kind === "page";
    for (const responseSave of [false, true]) {
      const { capture, page, secrets } = textEventCapture(new Set(["console"]));
      const value = fromPage
        ? "csrf-page-value-729d"
        : Buffer.from("user:password").toString("base64");
      const responseValue = "response-value-82ea";
      const message = consoleMessage(`${value} ${responseValue}`);
      page.emit("console", message);
      if (fromPage) secrets.admitPageValue("request.cookie", value);
      else secrets.basicCredential("request.auth", "user", "password");
      page.emit("console", message);
      if (responseSave)
        secrets.save("response.token", "token", responseValue, true);
      await capture.finish();

      const runtimeMarker = fromPage
        ? "[REDACTED:page:request.cookie]"
        : "[REDACTED:page:request.auth]";
      const later = responseSave
        ? "[REDACTED:page:response.token]"
        : responseValue;
      expect(capture.result().items).toMatchObject([
        { kind: "console", text: `${value} ${later}` },
        { kind: "console", text: `${runtimeMarker} ${later}` },
      ]);
    }
  },
);

it("preserves a response field recorded before a later page-value read while backfilling response secrets", async () => {
  const pageValue = "csrf-page-value-729d";
  const { capture, sourceId, value } = await sourceTransactionCapture({
    latePageValue: pageValue,
  });
  const first = capture
    .result()
    .items.find(
      (event) =>
        event.kind === "network-content" &&
        event.transaction_id === sourceId &&
        event.phase === "request",
    );
  expect(first).toBeDefined();
  if (first?.kind !== "network-content" || first.body.state !== "captured")
    throw new Error("Expected retained earlier request bytes");
  const body = JSON.parse(Buffer.from(first.body.content, "base64").toString());
  expect(body.page).toBe(pageValue);
  expect(body.token).toBe("[REDACTED:page:click.token]");
  expect(body.token).not.toContain(value);
});

it("promotes an already held page value to response scope without changing its first marker", () => {
  const parsed = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/fixture/browser" },
    start_url: { url: "https://example.test/" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  const secrets = resolveScenarioSecrets(parsed, {});
  const value = "existing-page-value-82ea";
  secrets.admitPageValue("cookie.token", value);
  expect(secrets.redact(value, "response")).toBe(value);
  expect(secrets.hasLearnedResponseSecrets()).toBe(false);
  secrets.save("response.token", "token", value, true);
  expect(secrets.hasLearnedResponseSecrets()).toBe(true);
  expect(secrets.redact(value, "response")).toBe(
    "[REDACTED:page:cookie.token]",
  );
  expect(secrets.redactBytes(Buffer.from(value), "response").toString()).toBe(
    "[REDACTED:page:cookie.token]",
  );
  secrets.admitPageValue("later.unrelated", "unrelated-page-value-729d");
  expect(secrets.redact("unrelated-page-value-729d", "response")).toBe(
    "unrelated-page-value-729d",
  );
  expect(secrets.redact(value, "response")).toBe(
    "[REDACTED:page:cookie.token]",
  );
});
