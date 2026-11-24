import { describe, expect, it } from "vitest";

import { receiveCdpEvent } from "../../../src/browser/CdpConnection.js";
import { CdpCaptureEvents } from "../../../src/browser/CdpCaptureEvents.js";
import { CdpTargetDocument } from "../../../src/browser/CdpTargetDocument.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import {
  webPageInspectionSchema,
  type WebPageInspection,
} from "../../../src/domain/browserObservationSchemas.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { compareWebCapturesInputSchema } from "../../../src/domain/webCaptureDiffSchemas.js";
import { passiveNetworkCapture } from "../../fixtures/passiveNetworkCapture.js";

const ORIGIN = "https://example.test";
const CAPTURE_TIME = "2026-01-01T00:00:00.000Z";
type BodySource = "request" | "response" | "base64 response";

it("captures all repeated array rows and empty arrays without retaining payload values", () => {
  const count = 6_000;
  const body = JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      value: index % 2 === 0 ? index : "payload-value-excluded",
      nested: index % 2 === 0 ? [] : [true, null],
      empty: [],
      "*": { "": "payload-value-excluded" },
    })),
  );
  const before = captureBody("base64 response", body);
  const shape = before.network.requests[0]?.body_shapes.response;
  const element = { kind: "array-element" };
  const property = (name: string) => ({ kind: "property", name });
  expect(shape).toMatchObject({
    root_type: "array",
    node_count: count * 7 + 1,
    max_depth_observed: 3,
    properties: [
      { path: [element], types: ["object"], observations: count },
      {
        path: [element, property("*")],
        types: ["object"],
        observations: count,
      },
      {
        path: [element, property("*"), property("")],
        types: ["string"],
        observations: count,
      },
      {
        path: [element, property("empty")],
        types: ["array"],
        observations: count,
      },
      {
        path: [element, property("nested")],
        types: ["array"],
        observations: count,
      },
      {
        path: [element, property("nested"), element],
        types: ["boolean", "null"],
        observations: count,
      },
      {
        path: [element, property("value")],
        types: ["number", "string"],
        observations: count,
      },
    ],
  });
  expect(JSON.stringify(shape)).not.toContain("payload-value-excluded");
});

const compareNetwork = (before: WebPageInspection, after: WebPageInspection) =>
  compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  ).dimensions.network;

/** Give retained request facts a complete, independently authored inventory. */
const completeInventory = (source: WebPageInspection): WebPageInspection => ({
  ...passiveNetworkCapture([]),
  target: source.target,
  network: source.network,
});

const body = '{"outer":[{"é/~":true,"e\u0301/~":null,"*":[1]},[]]}';
const reordered = '{"outer":[{"*":[1],"e\u0301/~":null,"é/~":true},[]]}';
const swappedTypes = '{"outer":[{"*":[1],"e\u0301/~":true,"é/~":null},[]]}';

it.each(["request", "response"] as const)(
  "compares complete %s shapes independently of wire length and key order",
  (source) => {
    expect(Buffer.byteLength(swappedTypes)).toBe(Buffer.byteLength(body));
    const before = captureBody(source, body);
    const after = captureBody(source, swappedTypes);
    const beforeRequest = before.network.requests[0]!;
    const afterRequest = after.network.requests[0]!;
    expect(beforeRequest.encoded_data_length).toBe(
      afterRequest.encoded_data_length,
    );
    expect(beforeRequest.body_shapes[source]).not.toEqual(
      afterRequest.body_shapes[source],
    );
    expect(compareNetwork(before, after)).toMatchObject({
      status: "unknown",
      total_changes: 0,
      changes: [],
    });
    expect(
      compareNetwork(
        completeInventory(before),
        completeInventory(captureBody(source, reordered)),
      ),
    ).toEqual({
      status: "unchanged",
      total_changes: 0,
      changes: [],
      reason: null,
    });
    expect(
      compareNetwork(completeInventory(before), completeInventory(after)),
    ).toEqual({
      status: "changed",
      total_changes: 1,
      changes: [
        { identity: expect.stringMatching(/^net_/u), change: "modified" },
      ],
      reason: null,
    });
  },
);

describe("CDP request body-shape coverage", () => {
  const jsonHeaders = { "Content-Type": "application/json" };

  it.each([
    {
      name: "an omitted",
      fields: { hasPostData: true },
      reason: "provider_unavailable",
      count: null,
    },
    {
      name: "an unparseable",
      fields: { postData: "{" },
      reason: "provider_unavailable",
      count: null,
    },
    {
      name: "a wrong-typed",
      fields: { postData: 7 },
      reason: "invalid_protocol_value",
      count: 1,
    },
  ])(
    "retains the response for $name JSON request body with partial coverage",
    ({ fields, reason, count }) => {
      const capture = captureBody("response", "[123]", {
        method: "POST",
        headers: jsonHeaders,
        ...fields,
      });
      expect(capture.network.requests[0]?.body_shapes).toMatchObject({
        status: "partial",
        request: null,
        response: { root_type: "array" },
      });
      expect(capture.completeness.unavailable_sections).toContain(
        "json_body_shapes",
      );
      expect(
        capture.completeness.excluded.filter(
          ({ section }) => section === "json_body_shapes",
        ),
      ).toEqual([{ section: "json_body_shapes", reason, count }]);
    },
  );

  it.each([
    {
      name: "a bodiless JSON-typed GET",
      request: { method: "GET", headers: jsonHeaders },
    },
    {
      name: "an omitted body without a media type",
      request: { method: "POST", headers: {}, hasPostData: true },
    },
    {
      name: "an omitted form body",
      request: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        hasPostData: true,
      },
    },
  ])("keeps response shape coverage for $name", ({ request }) => {
    const capture = captureBody("response", "[123]", request);
    expect(capture.network.requests[0]?.body_shapes).toMatchObject({
      status: "included",
      request: null,
      response: { root_type: "array" },
    });
    expect(capture.completeness.unavailable_sections).not.toContain(
      "json_body_shapes",
    );
  });
});

const captureBody = (
  source: BodySource,
  body: string,
  request: Record<string, unknown> = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    postData: source === "request" ? body : "{}",
  },
): WebPageInspection => {
  const events = new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: [ORIGIN],
      target_id: "page-1",
      observation_ms: 0,
      include_json_body_shapes: true,
    }),
    new Set([ORIGIN]),
  );
  events.beginAuthorizedFrame(new CdpTargetDocument({ frameId: "main" }));
  events.ingest(
    receiveCdpEvent({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "request-1",
        type: "Fetch",
        request: { url: `${ORIGIN}/api`, ...request },
        initiator: { type: "script" },
      },
    }),
  );
  const responseBody = source === "request" ? "{}" : body;
  events.ingest(
    receiveCdpEvent({
      method: "Network.responseReceived",
      params: {
        requestId: "request-1",
        response: {
          url: `${ORIGIN}/api`,
          status: 200,
          mimeType: "application/json",
          headers: {},
        },
      },
    }),
  );
  events.ingest(
    receiveCdpEvent({
      method: "Network.loadingFinished",
      params: {
        requestId: "request-1",
        encodedDataLength: Buffer.byteLength(responseBody),
      },
    }),
  );
  const candidate = events.responseBodyRequests()[0];
  if (candidate === undefined)
    throw new Error("Expected a response body request");
  events.ingestResponseBody(candidate, {
    body:
      source === "base64 response"
        ? Buffer.from(responseBody).toString("base64")
        : responseBody,
    base64Encoded: source === "base64 response",
  });
  // Keep the actual event records and attach-limited producer coverage.
  const authored = passiveNetworkCapture([]);
  return webPageInspectionSchema.parse({
    ...authored,
    target: { ...authored.target, url: ORIGIN, origin: ORIGIN, attached: true },
    completeness: events.completeness.snapshot(),
    network: { ...authored.network, requests: [...events.network.values()] },
  });
};
