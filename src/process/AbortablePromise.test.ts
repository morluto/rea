import { expect, it } from "vitest";

import { CallerAbort, cancelledBy } from "../domain/analysisErrorCore.js";
import { AbortedWait, waitForAbortable } from "./AbortablePromise.js";

it("carries the reason an abortable wait observed into its cancellation", async () => {
  const controller = new AbortController();
  const reason = new CallerAbort("client-disconnected");
  const waiting = waitForAbortable(
    new Promise<never>(() => undefined),
    controller.signal,
  );
  controller.abort(reason);

  const waited = await waiting;
  if (!(waited instanceof AbortedWait))
    throw new Error("Expected the abort to win", { cause: waited });
  expect(cancelledBy("wait", waited).cause).toBe(reason);
});

it("returns the pre-abort reason and still observes a producer rejection", async () => {
  const reason = "already cancelled";
  const rejected = Promise.reject(new Error("late producer failure"));
  const waited = await waitForAbortable(rejected, AbortSignal.abort(reason));

  expect(waited).toEqual(new AbortedWait(reason));
  // Give Node a turn to report a rejection if the waiter never observed it.
  await new Promise<void>((resolve) => setImmediate(resolve));
});
