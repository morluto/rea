import { expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { WEB_RUNTIME_LIMITS } from "../domain/webRuntime.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { CdpTargetDocument } from "./CdpTargetDocument.js";
import { receiveCdpEvent } from "./CdpConnection.js";

const origin = "http://127.0.0.1:43127";
const deep = (depth: number) => '{"a":'.repeat(depth) + "0" + "}".repeat(depth);
const createEvents = (selected = true) =>
  new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: origin,
      allowed_origins: [origin],
      target_id: "page",
      include_console_text: true,
      include_json_body_shapes: selected,
      include_websocket_shapes: selected,
    }),
    new Set([origin]),
  );
const request = (
  events: CdpCaptureEvents,
  id: string,
  body: string,
  redirect = false,
) => {
  events.ingest(
    receiveCdpEvent({
      method: "Network.requestWillBeSent",
      params: {
        requestId: id,
        timestamp: redirect ? 2 : 1,
        initiator: { type: "other" },
        request: {
          url: `${origin}/${redirect ? "next" : "first"}`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          postData: body,
        },
        ...(redirect
          ? {
              redirectResponse: {
                url: `${origin}/first`,
                status: 302,
                encodedDataLength: 0,
              },
            }
          : {}),
      },
    }),
  );
};
const response = (events: CdpCaptureEvents, id: string, body: string) => {
  events.ingest(
    receiveCdpEvent({
      method: "Network.responseReceived",
      params: {
        requestId: id,
        response: {
          url: `${origin}/first`,
          status: 200,
          mimeType: "application/json",
        },
      },
    }),
  );
  const candidate = events
    .responseBodyRequests()
    .find(({ requestId }) => requestId === id);
  if (candidate === undefined)
    throw new Error("Expected selected response body");
  events.ingestResponseBody(candidate, { body, base64Encoded: false });
  return candidate;
};
const openSocket = (events: CdpCaptureEvents) =>
  events.ingest(
    receiveCdpEvent({
      method: "Network.webSocketCreated",
      params: { requestId: "socket", url: `ws://${origin.slice(7)}/live` },
    }),
  );
const frame = (events: CdpCaptureEvents, payloadData: string) =>
  events.ingest(
    receiveCdpEvent({
      method: "Network.webSocketFrameReceived",
      params: { requestId: "socket", response: { opcode: 1, payloadData } },
    }),
  );

const log = (events: CdpCaptureEvents, timestamp: number, text: string) =>
  events.ingest(
    receiveCdpEvent({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        timestamp,
        args: [{ type: "string", value: text }],
        stackTrace: {
          callFrames: [
            { url: `${origin}/app.js`, lineNumber: 0, columnNumber: 0 },
          ],
        },
      },
    }),
  );

it("drops console events that do not fit and retains a later smaller entry", () => {
  const events = createEvents();
  const oneMiB = "é".repeat(512 * 1024);
  // Seven entries fit. The eighth and ninth exceed 8 MiB with their metadata.
  for (let timestamp = 1; timestamp <= 9; timestamp++)
    log(events, timestamp, oneMiB);
  log(events, 10, "still fits");

  expect(events.console.map(({ timestamp }) => timestamp)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 10,
  ]);
  expect(events.console.at(-1)?.text_capture.values).toMatchObject([
    { argument_index: 0, text: "still fits" },
  ]);
  const coverage = events.completeness.snapshot();
  expect(coverage.truncated_sections).toContain("console_events");
  expect(coverage.dropped_events).toMatchObject({
    console_events: 2,
    total: 2,
  });
});

it("selects request and response shapes by media type and retains its spelling", () => {
  const events = createEvents();
  const expectedCandidates: string[] = [];
  for (const [requestId, mediaType, selected] of [
    ["json", "\tAPPLICATION/JSON ; charset=utf-8\t", true],
    ["structured", "application/problem+json", true],
    ["non-application", "model/example+json", true],
    ["bare-suffix", "+json", false],
    ["space-in-type", "application /problem+json", false],
    ["newline-in-subtype", "application/problem\n+json", false],
    ["unicode-token", "application/\u212a+json", false],
    ["leading-newline", "\napplication/json", false],
    ["non-json", "text/plain", false],
  ] as const) {
    const url = `${origin}/${requestId}`;
    events.ingest(
      receiveCdpEvent({
        method: "Network.requestWillBeSent",
        params: {
          requestId,
          timestamp: 1,
          initiator: { type: "other" },
          request: {
            url,
            method: "POST",
            headers: { "Content-Type": mediaType },
            postData: '{"count":1}',
          },
        },
      }),
    );
    events.ingest(
      receiveCdpEvent({
        method: "Network.responseReceived",
        params: {
          requestId,
          response: { url, status: 200, mimeType: mediaType },
        },
      }),
    );
    expect(events.network.get(requestId), requestId).toMatchObject({
      mime_type: mediaType,
      body_shapes: { request: selected ? { root_type: "object" } : null },
    });
    if (selected) expectedCandidates.push(requestId);
  }
  expect(
    events.responseBodyRequests().map(({ requestId }) => requestId),
  ).toEqual(expectedCandidates);
});

it("distinguishes valid over-budget websocket JSON from non-JSON text", () => {
  const events = createEvents();
  openSocket(events);
  frame(events, '{"small":"frame"}');
  frame(events, deep(760));
  frame(events, "ordinary non-JSON text");
  expect(events.webSocketConnectionsById.get("socket")?.events).toMatchObject([
    { payload_shape: { format: "json", json_shape: { root_type: "object" } } },
    { payload_shape: { format: "text", json_shape: null } },
  ]);
  const coverage = events.completeness.snapshot();
  expect(coverage.dropped_events).toMatchObject({
    websocket_frames: 1,
    total: 1,
  });
  expect(coverage.excluded).toContainEqual({
    section: "websocket_shapes",
    reason: "resource_budget_exhausted",
    count: 1,
  });
});

it("retains the peer body facts when a selected request or response shape exceeds the allowance", () => {
  const events = createEvents();
  request(events, "request-large", deep(760));
  response(events, "request-large", '{"response":true}');
  expect(events.network.get("request-large")?.body_shapes).toMatchObject({
    status: "partial",
    request: null,
    response: { root_type: "object" },
  });
  request(events, "response-large", '{"request":true}');
  response(events, "response-large", deep(760));
  expect(events.network.get("response-large")?.body_shapes).toMatchObject({
    status: "partial",
    request: { root_type: "object" },
    response: null,
  });
  const coverage = events.completeness.snapshot();
  expect(coverage.truncated_sections).toContain("json_body_shapes");
  expect(coverage.excluded).toContainEqual({
    section: "json_body_shapes",
    reason: "resource_budget_exhausted",
    count: 2,
  });
});

it("reuses the prior allowance when replacing a retained response shape", () => {
  const events = createEvents();
  request(events, "repeat", '{"request":true}');
  // A second deep shape fits only when the previous shape is credited.
  const body = deep(600);
  const candidate = response(events, "repeat", body);
  const retained = events.retainedEventBytes;
  events.ingestResponseBody(candidate, {
    body,
    base64Encoded: false,
  });
  expect(events.retainedEventBytes).toBe(retained);
  response(events, "repeat", '{"smaller":true}');
  const shapes = events.network.get("repeat")?.body_shapes;
  if (shapes === undefined) throw new Error("Expected retained request");
  expect(shapes.status).toBe("included");
  expect(shapes.response?.max_depth_observed).toBe(1);
  expect(events.retainedEventBytes).toBeLessThan(retained);
  expect(events.retainedEventBytes).toBe(
    Buffer.byteLength(JSON.stringify(shapes.request)) +
      Buffer.byteLength(JSON.stringify(shapes.response)),
  );
  expect(events.completeness.snapshot().truncated_sections).not.toContain(
    "json_body_shapes",
  );
});

it("refunds replaced and removed request records while ignoring stale response occurrences", () => {
  const events = createEvents();
  request(events, "redirect", deep(100));
  const stale = response(events, "redirect", deep(100));
  request(events, "redirect", '{"next":true}', true);
  const retained = events.retainedEventBytes;
  events.ingestResponseBody(stale, { body: deep(760), base64Encoded: false });
  expect(events.retainedEventBytes).toBe(retained);
  expect(events.network.get("redirect")?.body_shapes.response).toBeNull();
  events.ingest(
    receiveCdpEvent({
      method: "Network.responseReceived",
      params: {
        requestId: "redirect",
        response: { url: "https://excluded.invalid/next", status: 200 },
      },
    }),
  );
  expect(events.network.has("redirect")).toBe(false);
  expect(events.retainedEventBytes).toBe(0);
  request(events, "fresh", deep(600));
  expect(events.network.get("fresh")?.body_shapes.status).toBe("included");
  events.beginAuthorizedFrame(new CdpTargetDocument({ frameId: "frame" }));
  expect(events.retainedEventBytes).toBe(0);
  request(events, "after-reset", deep(600));
  expect(events.network.get("after-reset")?.body_shapes.status).toBe(
    "included",
  );
});

it("shares the remaining allowance across console entries, body shapes and websocket shapes", () => {
  const events = createEvents();
  // The request and frame fit together, but all three retained shapes do not.
  log(events, 1, "x".repeat(1024 * 1024));
  request(events, "body", deep(600));
  expect(events.console).toHaveLength(1);
  expect(events.network.get("body")?.body_shapes.status).toBe("included");
  openSocket(events);
  frame(events, deep(400));
  expect(events.webSocketConnectionsById.get("socket")?.events).toHaveLength(0);
  const coverage = events.completeness.snapshot();
  expect(coverage.dropped_events).toMatchObject({
    console_events: 0,
    websocket_frames: 1,
    total: 1,
  });
  expect(coverage.excluded).toContainEqual({
    section: "websocket_shapes",
    reason: "resource_budget_exhausted",
    count: 1,
  });
  expect(events.retainedEventBytes).toBeLessThanOrEqual(
    WEB_RUNTIME_LIMITS.retainedEventBytes,
  );
  const withoutConsole = createEvents();
  request(withoutConsole, "body", deep(600));
  expect(withoutConsole.network.get("body")?.body_shapes.status).toBe(
    "included",
  );
  openSocket(withoutConsole);
  frame(withoutConsole, deep(400));
  expect(
    withoutConsole.webSocketConnectionsById.get("socket")?.events,
  ).toMatchObject([
    { payload_shape: { format: "json", json_shape: { root_type: "object" } } },
  ]);
});

it("does not infer unselected body or websocket shapes", () => {
  const events = createEvents(false);
  request(events, "unselected", deep(760));
  expect(events.network.get("unselected")?.body_shapes).toEqual({
    status: "not_approved",
    request: null,
    response: null,
  });
  expect(events.responseBodyRequests()).toEqual([]);
  openSocket(events);
  frame(events, deep(760));
  expect(events.webSocketConnectionsById.get("socket")?.events).toMatchObject([
    { payload_shape: null },
  ]);
  expect(events.completeness.snapshot().dropped_events.total).toBe(0);
});
