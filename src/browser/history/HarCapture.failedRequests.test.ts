import { expect, it } from "vitest";
import { historicalHar } from "../../../tests/fixtures/historicalHar.js";
import { decodeHarCapture } from "./HarCapture.js";

// Playwright 1.64.1, Chromium: a local server closed the socket before sending
// headers. The HAR exporter retained these response and timing sentinels.
const capture = () => {
  const fixture = historicalHar();
  const entry = fixture.log.entries[0]!;
  return {
    log: {
      ...fixture.log,
      creator: { name: "Playwright", version: "1.64.1" },
      entries: [
        entry,
        {
          ...entry,
          response: {
            ...entry.response,
            status: -1,
            statusText: "",
            content: { size: -1, mimeType: "x-unknown" },
            bodySize: -1,
            _failureText: "net::ERR_EMPTY_RESPONSE",
          },
          timings: { send: -1, wait: -1, receive: -1 },
        },
      ],
    },
  };
};

it("retains failed Playwright requests before and after headers without inventing timings", () => {
  const fixture = capture();
  const failedBeforeHeaders = fixture.log.entries[1]!;
  const entries = [
    ...fixture.log.entries,
    {
      ...failedBeforeHeaders,
      response: {
        ...failedBeforeHeaders.response,
        status: 200,
        _failureText: "net::ERR_CONTENT_LENGTH_MISMATCH",
      },
      timings: { send: 0, wait: 1.25, receive: -1 },
    },
  ];
  const decoded = decodeHarCapture(
    JSON.stringify({ log: { ...fixture.log, entries } }),
    [],
  );
  expect(decoded.records.map(({ reported }) => reported)).toEqual(entries);
  expect(
    decoded.records.map(({ limitations }) =>
      limitations.some((line) => line.includes("unavailable timings")),
    ),
  ).toEqual([false, true, true]);
});

it.each([
  "other-producer",
  "other-version",
  "empty-failure",
  "missing-failure",
  "invalid-duration",
])("keeps timing validation for %s", (variant) => {
  const fixture = capture();
  const failed = fixture.log.entries[1]!;
  if (variant === "other-producer") fixture.log.creator.name = "unknown";
  if (variant === "other-version") fixture.log.creator.version = "unknown";
  if (variant === "empty-failure")
    Object.assign(failed.response, { _failureText: "" });
  if (variant === "missing-failure")
    Reflect.deleteProperty(failed.response, "_failureText");
  if (variant === "invalid-duration") failed.timings.send = -2;
  expect(() => decodeHarCapture(JSON.stringify(fixture), [])).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({ kind: "malformed" }),
      pointer: "/log/entries/1/timings/send",
    }),
  );
});
