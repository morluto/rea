import { describe, expect, it } from "vitest";

import { WEB_RUNTIME_LIMITS } from "../../domain/webRuntime.js";
import { RuntimeRetention } from "./CdpRuntimeRetention.js";

describe("RuntimeRetention", () => {
  it("admits retention up to the limit and reports the total a refused charge would reach", () => {
    const retention = new RuntimeRetention("observe_web_runtime", "metadata");
    retention.charge(WEB_RUNTIME_LIMITS.retainedEventBytes - 1);
    retention.charge(1);
    expect(() => retention.charge(5)).toThrow(
      expect.objectContaining({
        reportedLimits: expect.objectContaining({
          kind: "metadata",
          retained_bytes: WEB_RUNTIME_LIMITS.retainedEventBytes + 5,
          limit_bytes: WEB_RUNTIME_LIMITS.retainedEventBytes,
        }),
        fixedAllowance: expect.objectContaining({
          limit: WEB_RUNTIME_LIMITS.retainedEventBytes,
          unit: "bytes",
        }),
      }),
    );
  });

  it("charges nothing for a refused retention", () => {
    const retention = new RuntimeRetention("observe_web_runtime", "requests");
    retention.charge(10);
    const room = WEB_RUNTIME_LIMITS.retainedEventBytes - 10;
    expect(() => retention.charge(room + 1)).toThrow(
      expect.objectContaining({
        reportedLimits: expect.objectContaining({
          retained_bytes: WEB_RUNTIME_LIMITS.retainedEventBytes + 1,
        }),
      }),
    );
    // The refused charge left the remaining room intact.
    expect(() => retention.charge(room)).not.toThrow();
  });

  it("keeps the source-text limit separate from metadata", () => {
    const retention = new RuntimeRetention("observe_web_runtime", "sources");
    expect(() => retention.charge(WEB_RUNTIME_LIMITS.sourceBytes + 1)).toThrow(
      expect.objectContaining({
        reportedLimits: expect.objectContaining({
          kind: "sources",
          limit_bytes: WEB_RUNTIME_LIMITS.sourceBytes,
        }),
      }),
    );
  });
});
