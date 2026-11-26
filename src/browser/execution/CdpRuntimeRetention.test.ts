import { expect, it } from "vitest";

import { WEB_RUNTIME_LIMITS } from "../../domain/webRuntime.js";
import { RuntimeRetention } from "./CdpRuntimeRetention.js";

it.each([
  ["metadata", WEB_RUNTIME_LIMITS.retainedEventBytes],
  ["sources", WEB_RUNTIME_LIMITS.sourceBytes],
] as const)(
  "admits complete %s retention at its limit and reports the attempted total",
  (kind, limit) => {
    const retention = new RuntimeRetention("observe_web_execution", kind);
    retention.charge(limit - 1);
    retention.charge(1);
    expect(() => retention.charge(5)).toThrow(
      expect.objectContaining({
        reportedLimits: {
          boundary: "browser-runtime-retention",
          kind,
          retained_bytes: limit + 5,
          limit_bytes: limit,
        },
        fixedAllowance: expect.objectContaining({
          limit,
          unit: "bytes",
        }),
      }),
    );
  },
);
