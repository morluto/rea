import { describe, expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import {
  primaryAnalysisError,
  type AnalysisError,
  type AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { finalizedResult, runOwned } from "./runOwned.js";

const value: AnalysisPartialObservation = {
  kind: "retained-evidence",
  evidence_id: "evidence-1",
};
const reason = { caller: "stop" };
const completedWork = async (): Promise<
  Result<AnalysisPartialObservation, AnalysisError>
> => ok(value);

/** A close that aborts the caller's signal, so cancellation lands during final cleanup. */
const closeThenAbort =
  (controller: AbortController, failure?: unknown) => async () => {
    controller.abort(reason);
    if (failure !== undefined) throw failure;
  };

const options = (controller: AbortController, close: () => Promise<void>) => ({
  providerId: "fixture",
  operation: "fixture_operation",
  signal: controller.signal,
  close,
});

describe("runOwned precedence", () => {
  it("completes when cleanup is released and no cancellation arrives", async () => {
    const controller = new AbortController();
    const finalized = await runOwned(
      completedWork,
      options(controller, async () => undefined),
    );
    expect(finalized).toEqual({ kind: "completed", value });
  });

  it("cancels a completed value when cancellation arrives during final cleanup before commit", async () => {
    const controller = new AbortController();
    const finalized = await runOwned(
      completedWork,
      options(controller, closeThenAbort(controller)),
    );
    expect(finalized.kind).toBe("cancelled");
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toBe(value);
  });

  it("keeps a committed value when cancellation arrives after the commit", async () => {
    const controller = new AbortController();
    const commits: unknown[] = [];
    const finalized = await runOwned(completedWork, {
      ...options(controller, closeThenAbort(controller)),
      commit: async (committed) => {
        commits.push(committed);
      },
    });
    expect(commits).toEqual([value]);
    expect(finalized).toEqual({
      kind: "completed",
      value,
      lateCancellation: reason,
    });
  });

  it("does not commit after cancellation and reports it before commit", async () => {
    const controller = new AbortController();
    controller.abort(reason);
    let committed = false;
    const finalized = await runOwned(completedWork, {
      ...options(controller, async () => undefined),
      commit: async () => {
        committed = true;
      },
    });
    expect(committed).toBe(false);
    expect(finalized.kind).toBe("cancelled");
  });

  it("keeps a recorded failure primary when cancellation arrives during final cleanup", async () => {
    const controller = new AbortController();
    const failure = new AnalysisProtocolError("fixture failure");
    const finalized = await runOwned(
      async () => err(failure),
      options(controller, closeThenAbort(controller)),
    );
    expect(finalized.kind).toBe("failed");
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected failure");
    expect(primaryAnalysisError(result.error)).toBe(failure);
    expect(failure.secondaryFailures).toEqual([
      expect.objectContaining({
        _tag: "AnalysisCancelledError",
        cause: reason,
      }),
    ]);
  });

  it("reports a completed value with unconfirmed cleanup as cleanup_incomplete keeping the value", async () => {
    const controller = new AbortController();
    const finalized = await runOwned(
      completedWork,
      options(controller, async () => {
        throw new Error("close failed");
      }),
    );
    expect(finalized.kind).toBe("completed-cleanup-retained");
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected cleanup failure");
    expect(result.error).toBeInstanceOf(ProviderCleanupError);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.partialObservation).toBe(value);
  });

  it("keeps the primary failure's identity when cleanup also fails", async () => {
    const controller = new AbortController();
    const failure = new AnalysisProtocolError("fixture failure");
    const cleanup = new ProviderCleanupError("fixture", ["fixture-run"], {
      reason: "still running",
    });
    const finalized = await runOwned(
      async () => err(failure),
      options(controller, async () => {
        throw cleanup;
      }),
    );
    expect(finalized).toMatchObject({
      kind: "failed",
      cleanup: { kind: "retained", failure: cleanup },
    });
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected failure");
    expect(primaryAnalysisError(result.error)).toBe(failure);
    expect(result.error.cleanupIncomplete).toBe(true);
  });

  it("types a thrown work failure as a provider adapter failure", async () => {
    const controller = new AbortController();
    const finalized = await runOwned(
      async () => {
        throw new Error("unexpected");
      },
      options(controller, async () => undefined),
    );
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected failure");
    expect(result.error._tag).toBe("ProviderAdapterError");
  });
});
