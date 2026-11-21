import { expect, it } from "vitest";

import {
  readCdpRequestWillBeSent,
  readCdpResponseReceived,
} from "./CdpNetworkEventFacts.js";

const invalidStatus = {
  ok: false,
  error: { _tag: "InvalidCdpResponseStatus" },
};

it.each([
  [undefined, { ok: true, value: null }],
  [null, invalidStatus],
  ["200", invalidStatus],
  [0, invalidStatus],
  [99, invalidStatus],
  [200.5, invalidStatus],
  [1000, invalidStatus],
  [100, { ok: true, value: 100 }],
  [302, { ok: true, value: 302 }],
  [600, { ok: true, value: 600 }],
  [999, { ok: true, value: 999 }],
] as const)(
  "reads CDP response status %s without losing other response facts",
  (status, expectedStatus) => {
    const fields = {
      url: "https://fixture.example/response",
      mimeType: "application/json",
      encodedDataLength: 0,
      headers: { "Content-Type": "application/json" },
    };
    const reported = status === undefined ? fields : { ...fields, status };
    const normal = readCdpResponseReceived({
      requestId: "fixture",
      response: reported,
    });
    const { redirect } = readCdpRequestWillBeSent({
      requestId: "fixture",
      redirectResponse: reported,
    });
    expect(normal.response).toMatchObject({
      source: reported,
      url: { source: fields.url },
      status: expectedStatus,
      mimeType: fields.mimeType,
      encodedDataLength: fields.encodedDataLength,
      headers: fields.headers,
    });
    expect(redirect).toEqual({ kind: "response", response: normal.response });
  },
);
