import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { browserNetworkBodySchema } from "./browserNetworkEvidence.js";
import { browserScenarioSchema } from "./browserScenario.js";

const bytes = Buffer.from([0xff, 0, 0xfe]);
const retained = {
  state: "captured",
  representation: "browser-decoded-response-bytes",
  encoding: "base64",
  content: bytes.toString("base64"),
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  media_type: null,
  redacted: false,
};

it("validates the actual retained bytes against canonical base64, count, and digest", () => {
  expect(browserNetworkBodySchema.safeParse(retained).success).toBe(true);
  for (const mutation of [
    { bytes: 4 },
    { sha256: "0".repeat(64) },
    { content: `${retained.content}\n` },
  ])
    expect(
      browserNetworkBodySchema.safeParse({ ...retained, ...mutation }).success,
    ).toBe(false);
});

it("defaults content selection independently and rejects unsupported controls", () => {
  const input = {
    browser: { mode: "launch", executable_path: "/fixture/chrome" },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "done", action: "wait_for_timeout", duration_ms: 1 }],
  };
  expect(browserScenarioSchema.parse(input).capture.network).toEqual({
    request_body: false,
    response_body: false,
    header_values: false,
  });
  expect(
    browserScenarioSchema.parse({
      ...input,
      capture: { network: { response_body: true } },
    }).capture.network,
  ).toEqual({ request_body: false, response_body: true, header_values: false });
  expect(
    browserScenarioSchema.safeParse({
      ...input,
      capture: { network: { refetch: true } },
    }).success,
  ).toBe(false);
});
