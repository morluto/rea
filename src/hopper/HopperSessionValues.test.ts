import { expect, it } from "vitest";

import { DEFAULT_BRIDGE_MAX_REQUEST_BYTES } from "../domain/analysisResourceLimits.js";
import { HopperProtocolError } from "../domain/hopperErrors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { parseHopperServerInfo } from "./HopperSessionValues.js";

const health = {
  name: "REA Hopper bridge",
  version: "1.0.0",
  process_id: 42,
  run_id: "run-1",
};

it("treats an omitted request ceiling as the 16 MiB default", () => {
  const parsed = parseHopperServerInfo(health, "run-1");
  expect(parsed).toEqual({
    ok: true,
    value: {
      name: "REA Hopper bridge",
      version: "1.0.0",
      processId: 42,
      maxRequestBytes: DEFAULT_BRIDGE_MAX_REQUEST_BYTES,
    },
  });
});

it("keeps an advertised ceiling that differs from the client default", () => {
  const parsed = parseHopperServerInfo(
    { ...health, max_request_bytes: 8192 },
    "run-1",
  );
  expect(parsed.ok && parsed.value.maxRequestBytes).toBe(8192);
});

it.each([0, -1, 1.5, "16777216", true])(
  "rejects an unusable advertised ceiling %j",
  (max_request_bytes) => {
    const parsed = parseHopperServerInfo(
      { ...health, max_request_bytes },
      "run-1",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.error.message).toBe(
        "Hopper bridge health result is invalid",
      );
  },
);

it.each<[string, JsonValue]>([
  ["another launch's run id", { ...health, run_id: "run-2" }],
  ["another bridge name", { ...health, name: "Other bridge" }],
  ["no process id", { name: health.name, version: "1", run_id: "run-1" }],
  ["an unsafe process id", { ...health, process_id: 2 ** 53 }],
  ["a non-object reply", ["REA Hopper bridge"]],
])("rejects a health reply with %s", (_case, reply) => {
  const parsed = parseHopperServerInfo(reply, "run-1");
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.error).toBeInstanceOf(HopperProtocolError);
});
