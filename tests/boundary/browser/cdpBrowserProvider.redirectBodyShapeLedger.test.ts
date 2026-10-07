import { expect, it } from "vitest";

import { CdpCaptureEvents } from "../../../src/browser/CdpCaptureEvents.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";

it("preserves an already captured response shape without marking it unavailable", () => {
  const origin = "http://127.0.0.1:43127";
  const events = new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: origin,
      allowed_origins: [origin],
      target_id: "allowed-page",
      include_json_body_shapes: true,
    }),
    new Set([origin]),
  );
  events.ingest({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "request-1",
      request: {
        url: `${origin}/prior`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        postData: '{"request":true}',
      },
      timestamp: 1,
    },
  });
  events.ingest({
    method: "Network.responseReceived",
    params: {
      requestId: "request-1",
      response: {
        url: `${origin}/prior`,
        status: 200,
        mimeType: "application/json",
      },
    },
  });
  events.ingestResponseBody("request-1", {
    body: '{"response":true}',
    base64Encoded: false,
  });
  const capturedShape = events.network.get("request-1")?.body_shapes.response;
  expect(capturedShape).not.toBeNull();

  events.ingest({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "request-1",
      request: { url: `${origin}/continuation`, method: "GET" },
      redirectResponse: null,
      timestamp: 2,
    },
  });

  expect(events.network.get("request-1")?.body_shapes.response).toEqual(
    capturedShape,
  );
  expect(events.network.get("request-1")?.body_shapes.status).toBe("included");
  expect(events.responseBodyRequestIds()).toEqual([]);
  expect(events.completeness.snapshot().unavailable_sections).not.toContain(
    "json_body_shapes",
  );
});
