import { expect, it } from "vitest";

import { createDeferred } from "../../tests/fixtures/binarySession.js";
import { OwnerCancellation } from "../domain/analysisErrorCore.js";
import { SharedStartupAttempt } from "./SharedStartupAttempt.js";

it("keeps shared startup running for an interested peer and returns the departing caller's reason", async () => {
  const completed = createDeferred<string>();
  const attempt = new SharedStartupAttempt(() => completed.promise);
  const controller = new AbortController();
  const departing = attempt.wait(controller.signal);
  const staying = attempt.wait();
  const reason = { caller: "departing" };
  controller.abort(reason);
  const departed = await departing;
  expect(departed).toEqual({ status: "cancelled", reason });
  expect(departed.status === "cancelled" ? departed.reason : undefined).toBe(
    reason,
  );
  expect(attempt.signal.aborted).toBe(false);
  completed.resolve("ready");
  await expect(staying).resolves.toEqual({
    status: "completed",
    value: "ready",
  });
});

it("retains the final cleanup result when all callers cancel together", async () => {
  const cleanup = createDeferred<{ cleanupIncomplete: boolean }>();
  const attempt = new SharedStartupAttempt(() => cleanup.promise);
  const first = new AbortController();
  const last = new AbortController();
  const waits = [attempt.wait(first.signal), attempt.wait(last.signal)];
  const firstReason = new Error("first caller left");
  first.abort(firstReason);
  last.abort();
  await expect(waits[0]).resolves.toEqual({
    status: "cancelled",
    reason: firstReason,
  });
  expect(attempt.signal.aborted).toBe(true);
  expect(attempt.settled).toBe(false);
  const failure = { cleanupIncomplete: true };
  cleanup.resolve(failure);
  await expect(waits[1]).resolves.toEqual({
    status: "stopped",
    value: failure,
  });
  expect(attempt.settled).toBe(true);
});

it("does not lose an unexpected producer rejection after its final caller cancels", async () => {
  let reject: ((cause: unknown) => void) | undefined;
  const promise = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  const attempt = new SharedStartupAttempt(() => promise);
  const controller = new AbortController();
  const waiting = attempt.wait(controller.signal);
  controller.abort();
  const cause = new TypeError("Cleanup rejected");
  reject?.(cause);
  await expect(waiting).rejects.toBe(cause);
});

it.each([
  { first: "provider closure", concurrent: false },
  { first: "provider closure", concurrent: true },
  { first: "owning cancellation", concurrent: true },
] as const)(
  "keeps the first owner reason for $first (concurrent=$concurrent)",
  async ({ first, concurrent }) => {
    const completed = createDeferred<string>();
    const owner = new AbortController();
    const caller = new AbortController();
    const reason = { caller: "operation owner" };
    const attempt = new SharedStartupAttempt(
      () => completed.promise,
      concurrent ? owner.signal : undefined,
    );
    const waiting = attempt.wait(caller.signal);
    if (first === "owning cancellation") owner.abort(reason);
    attempt.close();
    if (concurrent) owner.abort(reason);
    expect(attempt.signal.reason).toBe(
      first === "owning cancellation"
        ? reason
        : OwnerCancellation.startupOwnerClosed,
    );
    expect(caller.signal.aborted).toBe(false);
    expect(attempt.settled).toBe(false);
    completed.resolve("finalized");
    await expect(waiting).resolves.toEqual({
      status: "completed",
      value: "finalized",
    });
  },
);
