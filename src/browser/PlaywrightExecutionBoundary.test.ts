import { afterEach, describe, expect, it, vi } from "vitest";

import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/errors.js";

describe("withPlaywrightExecutionBoundary", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects work that exceeds its absolute remaining duration", async () => {
    vi.useFakeTimers();
    const result = withPlaywrightExecutionBoundary(
      () => new Promise<never>(() => undefined),
      25,
    );
    const rejection =
      expect(result).rejects.toBeInstanceOf(AnalysisTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("rejects when the caller cancels active work", async () => {
    const controller = new AbortController();
    const result = withPlaywrightExecutionBoundary(
      () => new Promise<never>(() => undefined),
      1_000,
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(AnalysisCancelledError);
  });
});
