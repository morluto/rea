import { expect, it } from "vitest";

import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { webPageInspectionSchema } from "../domain/browserObservationSchemas.js";
import { receiveCdpEvent } from "./CdpConnection.js";

it("preserves finite console timestamps and reports missing or malformed values by event", () => {
  const origin = "http://127.0.0.1:43127";
  const capture = new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: origin,
      allowed_origins: [origin],
      target_id: "allowed-page",
    }),
    new Set([origin]),
  );
  const cases = [
    ["omitted", {}, null],
    ["epoch", { timestamp: 0 }, 0],
    ["non-finite", { timestamp: Number.NaN }, null],
    ["string", { timestamp: "123" }, null],
    ["before-epoch", { timestamp: -1 }, -1],
    ["null", { timestamp: null }, null],
  ] as const;
  let invalidCount = 0;
  for (const [index, [label, reported, expected]] of cases.entries()) {
    const url = `${origin}/${label}.js`;
    capture.ingest(
      receiveCdpEvent({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "log",
          args: [],
          stackTrace: {
            callFrames: [{ url, lineNumber: 0, columnNumber: 0 }],
          },
          ...reported,
        },
      }),
    );
    expect(capture.console, label).toHaveLength(index + 1);
    expect(capture.console[index], label).toMatchObject({
      url,
      timestamp: expected,
    });
    invalidCount += expected === null ? 1 : 0;
    expect(capture.completeness.snapshot().excluded, label).toEqual([
      {
        section: "console_events",
        reason: "invalid_protocol_value",
        count: invalidCount,
      },
    ]);
  }
  expect(
    webPageInspectionSchema.shape.console.shape.events.safeParse(
      capture.console,
    ).success,
  ).toBe(true);
});
