import { expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { receiveCdpEvent } from "./CdpConnection.js";

const ORIGIN = "https://example.test";
const CDP_ENDPOINT = "http://127.0.0.1:9222";
const BODY_BYTES = 4 * 1024 * 1024;

const createEvents = (includeJsonBodyShapes = true): CdpCaptureEvents =>
  new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: CDP_ENDPOINT,
      allowed_origins: [ORIGIN],
      target_id: "page",
      include_json_body_shapes: includeJsonBodyShapes,
    }),
    new Set([ORIGIN]),
  );

const startJsonResponse = (
  events: CdpCaptureEvents,
  requestId: string,
  path: string,
): void => {
  events.ingest(
    receiveCdpEvent({
      method: "Network.requestWillBeSent",
      params: {
        requestId,
        request: { url: `${ORIGIN}${path}`, method: "GET" },
        initiator: { type: "other" },
        timestamp: 1,
      },
    }),
  );
  events.ingest(
    receiveCdpEvent({
      method: "Network.responseReceived",
      params: {
        requestId,
        response: {
          url: `${ORIGIN}${path}`,
          status: 200,
          mimeType: "application/json",
        },
      },
    }),
  );
};

it("decodes large JSON response bodies and accepts nonzero pad bits", () => {
  const events = createEvents();
  startJsonResponse(events, "large-json", "/large.json");
  const encoded = Buffer.from(
    JSON.stringify({ value: "x".repeat(BODY_BYTES) }),
  ).toString("base64");
  const candidate = events.responseBodyRequests()[0];
  expect(candidate).toBeDefined();
  events.ingestResponseBody(candidate!, {
    body: encoded,
    base64Encoded: true,
  });
  expect(events.network.get("large-json")?.body_shapes.response).toMatchObject({
    root_type: "object",
    node_count: 2,
  });

  startJsonResponse(events, "pad-bits", "/pad-bits.json");
  const padBits = events
    .responseBodyRequests()
    .find(({ requestId }) => requestId === "pad-bits");
  expect(padBits).toBeDefined();
  events.ingestResponseBody(padBits!, {
    body: "e31=",
    base64Encoded: true,
  });
  expect(events.network.get("pad-bits")?.body_shapes.response?.root_type).toBe(
    "object",
  );
});

it("counts bytes from large binary WebSocket frames", () => {
  const events = createEvents(false);
  const encoded = Buffer.alloc(BODY_BYTES, 0x81).toString("base64");
  events.ingest(
    receiveCdpEvent({
      method: "Network.webSocketCreated",
      params: { requestId: "socket", url: "wss://example.test/socket" },
    }),
  );
  events.ingest(
    receiveCdpEvent({
      method: "Network.webSocketFrameReceived",
      params: {
        requestId: "socket",
        response: { opcode: 2, payloadData: encoded },
      },
    }),
  );
  expect(
    events.webSocketConnectionsById.get("socket")?.events[0]?.payload_bytes,
  ).toBe(BODY_BYTES);
});
