import { getEventListeners } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";

describe("withPlaywrightExecutionBoundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "expires at the monotonic deadline despite a wall-clock jump (policy error: %s)",
    async (customTimeout) => {
      vi.useFakeTimers();
      const timeout = new AnalysisTimeoutError("capture_browser_scenario", 25, {
        userMessage: "Fixed service-worker policy deadline.",
      });
      const observe = vi.fn();
      const result = withPlaywrightExecutionBoundary(
        () => new Promise<never>(() => {}),
        25,
        undefined,
        customTimeout ? () => timeout : undefined,
      );
      void result.then(observe, observe);
      vi.setSystemTime(Date.now() - 10_000_000);
      await vi.advanceTimersByTimeAsync(24);
      expect(observe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(observe).toHaveBeenCalledOnce();
      const error: unknown = observe.mock.calls[0]![0];
      if (customTimeout) expect(error).toBe(timeout);
      else
        expect(error).toMatchObject({
          _tag: "AnalysisTimeoutError",
          operation: "capture_browser_scenario",
          timeoutMs: 25,
        });
    },
  );

  it("does not admit work or attach cancellation after synchronous expiry", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_001);
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const work = vi.fn(async () => "unreachable");

    await expect(
      withPlaywrightExecutionBoundary(work, 0.5, controller.signal),
    ).rejects.toBeInstanceOf(AnalysisTimeoutError);
    expect(work).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
  });

  it("cleans up when admitted work throws synchronously", async () => {
    vi.useFakeTimers();
    const cause = { opaque: true };
    const controller = new AbortController();
    const work = vi.fn((): Promise<never> => {
      throw cause;
    });
    const pending = withPlaywrightExecutionBoundary(
      work,
      1_000,
      controller.signal,
    );

    await expect(pending).rejects.toBe(cause);
    expect(work).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["before", "during"] as const)(
    "keeps typed caller reasons opaque when cancelled %s work",
    async (phase) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const reason = new AnalysisTimeoutError("capture_browser_scenario", 123);
      if (phase === "before") caller.abort(reason);
      const work = vi.fn(() => new Promise<never>(() => {}));
      const pending = withPlaywrightExecutionBoundary(
        work,
        1_000,
        caller.signal,
      );
      if (phase === "during") caller.abort(reason);
      const error: unknown = await pending.catch((cause: unknown) => cause);
      if (!(error instanceof AnalysisCancelledError))
        throw new Error("Expected typed cancellation");
      expect(error.cause).toBe(reason);
      expect(work).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
