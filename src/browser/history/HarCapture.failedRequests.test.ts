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

it.each([
  {
    status: -1,
    failure: "net::ERR_EMPTY_RESPONSE",
    timings: { send: -1, wait: -1, receive: -1 },
  },
  {
    status: 200,
    failure: "net::ERR_CONTENT_LENGTH_MISMATCH",
    timings: { send: 0, wait: 1.25, receive: -1 },
  },
])(
  "retains failed Playwright requests with status $status without inventing timings",
  ({ status, failure, timings }) => {
    const fixture = capture();
    Object.assign(fixture.log.entries[1]!.response, {
      status,
      _failureText: failure,
    });
    fixture.log.entries[1]!.timings = timings;
    const result = decodeHarCapture(JSON.stringify(fixture), []);
    expect(result.total_records).toBe(2);
    expect(result.records[0]?.reported).toMatchObject({
      response: { status: 200 },
      timings: { send: 0, wait: 1.25, receive: 0 },
    });
    expect(result.records[1]?.reported).toMatchObject({
      response: { status, _failureText: failure },
      timings,
    });
    expect(result.records[1]?.limitations.join(" ")).toContain("unavailable");
    expect(result.records[0]?.limitations.join(" ")).not.toContain(
      "unavailable timings",
    );
  },
);

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
  if (variant === "empty-failure") failed.response._failureText = "";
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
