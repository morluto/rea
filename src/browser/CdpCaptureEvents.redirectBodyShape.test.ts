import { expect, it } from "vitest";

import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { inspectWebPageInputSchema } from "../domain/browserObservation.js";

it("retains response source on redirect hops independently of the final response", () => {
  const origin = "https://app.example.test";
  const events = new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
      allowed_origins: [origin],
    }),
    new Set([origin]),
  );
  const request = {
    requestId: "r",
    initiator: { type: "other" },
    request: { url: origin + "/start", method: "GET" },
  };
  events.ingest({ method: "Network.requestWillBeSent", params: request });
  events.ingest({
    method: "Network.requestWillBeSent",
    params: {
      ...request,
      request: { url: origin + "/end", method: "GET" },
      redirectResponse: {
        url: origin + "/start",
        status: 302,
        mimeType: "text/html",
        encodedDataLength: 0,
        fromServiceWorker: true,
        fromDiskCache: false,
        serviceWorkerResponseSource: "cache-storage",
      },
    },
  });
  events.ingest({
    method: "Network.responseReceived",
    params: {
      requestId: "r",
      response: {
        url: origin + "/end",
        status: 200,
        fromServiceWorker: false,
        fromDiskCache: true,
      },
    },
  });
  expect(events.network.get("r")).toMatchObject({
    redirects: [
      {
        response_source: {
          service_worker: true,
          disk_cache: false,
          service_worker_response_source: "cache-storage",
        },
      },
    ],
    response_source: { service_worker: false, disk_cache: true },
  });
});

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
      initiator: { type: "other" },
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
  const candidate = events.responseBodyRequests()[0];
  expect(candidate).toBeDefined();
  events.ingestResponseBody(candidate!, {
    body: '{"response":true}',
    base64Encoded: false,
  });
  const capturedShape = events.network.get("request-1")?.body_shapes.response;
  expect(capturedShape).toBeDefined();
  expect(capturedShape).not.toBeNull();

  events.ingest({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "request-1",
      request: { url: `${origin}/continuation`, method: "GET" },
      initiator: { type: "other" },
      redirectResponse: null,
      timestamp: 2,
    },
  });

  expect(events.network.get("request-1")?.body_shapes.response).toEqual(
    capturedShape,
  );
  expect(events.network.get("request-1")?.body_shapes.status).toBe("included");
  expect(events.responseBodyRequests()).toEqual([]);
  expect(events.completeness.snapshot().unavailable_sections).not.toContain(
    "json_body_shapes",
  );
});
