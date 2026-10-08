import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { completeJavaScriptAnalysisSteps } from "./JavaScriptAnalysisControl.js";

describe("JavaScript cooperative computation lifecycle", () => {
  it("observes scheduler cancellation and closes abandoned work", async () => {
    const controller = new AbortController();
    let released = false;
    function* work(): Generator<void, number> {
      try {
        for (;;) yield;
      } finally {
        released = true;
      }
    }
    const cancellation = setImmediate().then(() => controller.abort());
    await expect(
      completeJavaScriptAnalysisSteps(work(), controller.signal),
    ).rejects.toMatchObject({ reason: "cancelled" });
    await cancellation;
    expect(released).toBe(true);
  });

  it("does not start pre-cancelled work and preserves completed values", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    function* work(): Generator<void, number> {
      started = true;
      yield;
      return 42;
    }
    await expect(
      completeJavaScriptAnalysisSteps(work(), controller.signal),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(started).toBe(false);
    expect(await completeJavaScriptAnalysisSteps(work())).toBe(42);
  });
});
