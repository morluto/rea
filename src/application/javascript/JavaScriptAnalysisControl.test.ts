import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { completeJavaScriptAnalysisSteps } from "./JavaScriptAnalysisControl.js";

describe("JavaScript cooperative computation lifecycle", () => {
  it("observes scheduler cancellation and closes abandoned work", async () => {
    const controller = new AbortController();
    const reason = { request: "caller cancelled computation" };
    let released = false;
    function* work(): Generator<void, number> {
      try {
        for (;;) yield;
      } finally {
        released = true;
      }
    }
    const cancellation = setImmediate().then(() => controller.abort(reason));
    const failure = await completeJavaScriptAnalysisSteps(
      work(),
      controller.signal,
    ).then(
      () => {
        throw new Error("Expected cancellation");
      },
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure)) throw failure;
    expect(failure.reason).toBe("cancelled");
    expect(failure.cause).toBe(reason);
    await cancellation;
    expect(released).toBe(true);
  });

  it("does not start pre-cancelled work and preserves completed values", async () => {
    const controller = new AbortController();
    const reason = { request: "caller cancelled computation" };
    controller.abort(reason);
    let started = false;
    function* work(): Generator<void, number> {
      started = true;
      yield;
      return 42;
    }
    const failure = await completeJavaScriptAnalysisSteps(
      work(),
      controller.signal,
    ).then(
      () => {
        throw new Error("Expected cancellation");
      },
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure)) throw failure;
    expect(failure.reason).toBe("cancelled");
    expect(failure.cause).toBe(reason);
    expect(started).toBe(false);
    expect(await completeJavaScriptAnalysisSteps(work())).toBe(42);
  });
});
