import { expect, it } from "vitest";

import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";

it("publishes accumulated capture limits and restores only the initial attach window", () => {
  const capture = new CdpCaptureCompleteness([
    "network_requests",
    "websocket_frames",
  ]);
  const initial = capture.snapshot();
  expect(initial).toMatchObject({
    status: "attach_limited",
    conditions: ["attach_limited"],
    attach_limited_sections: ["network_requests", "websocket_frames"],
    excluded: [],
    dropped_events: { total: 0 },
  });

  capture.exclude("scripts", "disallowed_origin");
  capture.exclude("scripts", "disallowed_origin", 2);
  capture.exclude("storage_keys", "not_approved");
  capture.exclude("storage_keys", "not_approved", null);
  capture.exclude("storage_keys", "not_approved", 2);
  expect(capture.snapshot().status).toBe("policy_filtered");

  capture.attachLimited("frames");
  capture.unavailable("resources");
  capture.drop("console_events", 4);
  capture.drop("timeline_events", 2);
  const limited = capture.snapshot();
  expect(limited).toMatchObject({
    status: "truncated",
    conditions: ["attach_limited", "policy_filtered", "truncated"],
    attach_limited_sections: ["frames", "network_requests", "websocket_frames"],
    policy_filtered_sections: ["scripts", "storage_keys"],
    truncated_sections: ["console_events", "timeline"],
    unavailable_sections: ["resources"],
    excluded: [
      { section: "resources", reason: "provider_unavailable", count: null },
      { section: "scripts", reason: "disallowed_origin", count: 3 },
      { section: "storage_keys", reason: "not_approved", count: null },
    ],
    dropped_events: { console_events: 4, timeline_events: 2, total: 6 },
  });

  const published = structuredClone(limited);
  capture.reset();
  expect(capture.snapshot()).toEqual(initial);
  expect(limited).toEqual(published);
});
