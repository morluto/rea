import { expect, it } from "vitest";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import {
  primaryAnalysisError,
  type AnalysisError,
  type AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
  cancelledBy,
  OwnerCancellation,
} from "../domain/analysisErrorCore.js";
import { Deadline } from "../domain/deadline.js";
import { ok, err, type Result } from "../domain/result.js";
import { finalizedResult, runOwned, type Finalized } from "./runOwned.js";

const operation = "fixture_operation";
const project = (value: { readonly count: number }) =>
  ({
    kind: "retained-evidence",
    evidence_id: `counted-${String(value.count)}`,
  }) satisfies AnalysisPartialObservation;

const failure = <Value>(finalized: Finalized<Value>): AnalysisError => {
  const result = finalizedResult(finalized);
  if (result.ok) throw new Error(`expected an error, got ${finalized.kind}`);
  return result.error;
};

/** Work that runs until its signal aborts, then reports that cancellation. */
const untilAborted = (
  signal: AbortSignal | undefined,
): Promise<Result<{ readonly count: number }, AnalysisError>> =>
  new Promise((resolve) => {
    if (signal === undefined) throw new Error("expected a work signal");
    const cancelled = () =>
      resolve(
        err(
          cancelledBy(operation, signal as AbortSignal & { aborted: true }, {
            partialObservation: project({ count: 1 }),
          }),
        ),
      );
    if (signal.aborted) cancelled();
    else signal.addEventListener("abort", cancelled, { once: true });
  });

it("reports an elapsed work budget as a timeout, not a cancellation", async () => {
  let closes = 0;
  let observedReason: unknown;
  const finalized = await runOwned(
    async (signal) => {
      const result = await untilAborted(signal);
      observedReason = signal?.reason;
      return result;
    },
    {
      providerId: "fixture",
      operation,
      deadline: Deadline.after(20, { finalizeMs: 1000 }),
      close: async () => {
        closes += 1;
      },
      partial: project,
    },
  );
  expect(observedReason).toBe(OwnerCancellation.deadlineElapsed);
  expect(finalized.kind).toBe("failed");
  const error = failure(finalized);
  expect(error).toBeInstanceOf(AnalysisTimeoutError);
  expect(error).toMatchObject({ operation, timeoutMs: 20 });
  expect(error.cause).toBeInstanceOf(AnalysisCancelledError);
  // The work's partial observation survives the replacement.
  expect(error.partialObservation).toEqual(project({ count: 1 }));
  expect(error.cleanupIncomplete).toBe(false);
  expect(closes).toBe(1);
});

it("keeps a value that arrived after the work budget as a timeout and does not publish it", async () => {
  const commits: unknown[] = [];
  const finalized = await runOwned(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return ok({ count: 3 });
    },
    {
      providerId: "fixture",
      operation,
      deadline: Deadline.after(5),
      close: async () => undefined,
      commit: async (value) => {
        commits.push(value);
      },
      partial: project,
    },
  );
  expect(commits).toEqual([]);
  const error = failure(finalized);
  expect(error).toBeInstanceOf(AnalysisTimeoutError);
  expect(error.partialObservation).toEqual(project({ count: 3 }));
});

it("keeps a caller abort a cancellation even when the work budget also elapsed", async () => {
  const caller = new AbortController();
  const callerReason = { caller: "stop" };
  const finalized = await runOwned(
    async (signal) => {
      caller.abort(callerReason);
      const result = await untilAborted(signal);
      // Let the work budget elapse before the outcome is classified.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return result;
    },
    {
      providerId: "fixture",
      operation,
      signal: caller.signal,
      deadline: Deadline.after(5),
      close: async () => undefined,
      partial: project,
    },
  );
  expect(finalized.kind).toBe("cancelled");
  const error = failure(finalized);
  expect(error).toBeInstanceOf(AnalysisCancelledError);
  expect(error.cause).toBe(callerReason);
});

it("completes work that finishes within its budget and stops the budget timer", async () => {
  let workSignal: AbortSignal | undefined;
  const finalized = await runOwned(
    async (signal) => {
      workSignal = signal;
      return ok({ count: 3 });
    },
    {
      providerId: "fixture",
      operation,
      deadline: Deadline.after(20),
      close: async () => undefined,
      partial: project,
    },
  );
  expect(finalized).toEqual({ kind: "completed", value: { count: 3 } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(workSignal?.aborted).toBe(false);
});

it("leaves cleanup incomplete with its leases retained when close outlasts the finalize budget", async () => {
  let finishClose!: () => void;
  const closing = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  let released = false;
  const lease = new AnalysisCleanupLease(async () => {
    await closing;
    released = true;
  }, ["/owned/root"]);
  const finalized = await runOwned(async () => ok({ count: 3 }), {
    providerId: "fixture",
    operation,
    deadline: Deadline.after(1000, { finalizeMs: 10 }),
    cleanupLeases: [lease],
    close: () => lease.release(),
    partial: project,
  });
  expect(finalized.kind).toBe("completed-cleanup-retained");
  if (finalized.kind !== "completed-cleanup-retained")
    throw new Error("expected retained cleanup");
  expect(finalized.value).toEqual({ count: 3 });
  expect(finalized.error.cleanupIncomplete).toBe(true);
  expect(finalized.error.cleanupResources).toEqual(["/owned/root"]);
  expect(released).toBe(false);
  // The close still running confirms the lease; that resolves the failure.
  finishClose();
  await lease.release();
  expect(released).toBe(true);
  expect(finalized.error.cleanupIncomplete).toBe(false);
});

it("keeps the close still running as the lease when close outlasts the finalize budget without leases", async () => {
  let finishClose!: () => void;
  const finalized = await runOwned(async () => ok({ count: 3 }), {
    providerId: "fixture",
    operation,
    deadline: Deadline.after(1000, { finalizeMs: 10 }),
    fallbackResource: "fixture runtime",
    close: () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
    partial: project,
  });
  if (finalized.kind !== "completed-cleanup-retained")
    throw new Error(`expected retained cleanup, got ${finalized.kind}`);
  expect(finalized.error.cleanupIncomplete).toBe(true);
  expect(finalized.error.cleanupResources).toEqual(["fixture runtime"]);
  finishClose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(finalized.error.cleanupIncomplete).toBe(false);
});

it("keeps a work timeout primary when close also outlasts the finalize budget", async () => {
  const finalized = await runOwned(untilAborted, {
    providerId: "fixture",
    operation,
    deadline: Deadline.after(5, { finalizeMs: 5 }),
    close: () => new Promise<void>(() => undefined),
    partial: project,
  });
  expect(finalized.kind).toBe("failed");
  const error = failure(finalized);
  expect(error.cleanupIncomplete).toBe(true);
  expect(primaryAnalysisError(error)).toBeInstanceOf(AnalysisTimeoutError);
});
