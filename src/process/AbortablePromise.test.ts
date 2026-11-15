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
  expect(waited).toBeInstanceOf(AbortedWait);
  if (!(waited instanceof AbortedWait)) return;
  expect(cancelledBy("wait", waited).cause).toBe(reason);
});

it("carries the reason of a signal that aborted before the wait began", async () => {
  const controller = new AbortController();
  controller.abort("already");
  const waited = await waitForAbortable(Promise.resolve(1), controller.signal);
  expect(waited).toEqual(new AbortedWait("already"));
});
