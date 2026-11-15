import { expect, it, vi } from "vitest";
import { AnalysisCancelledError } from "./analysisErrorCore.js";
import { createDeferred } from "../../tests/fixtures/binarySession.js";
import { awaitPredecessor } from "./awaitPredecessor.js";

it.each(["already", "during"] as const)(
  "preserves the caller reason and releases the abort listener when cancelled %s the wait",
  async (stage) => {
    const predecessor = createDeferred<void>();
    const controller = new AbortController();
    const reason = { caller: "opaque cancellation value" };
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    try {
      if (stage === "already") controller.abort(reason);
      const waiting = awaitPredecessor(
        predecessor.promise,
        "inspect_adb_ui",
        controller.signal,
      );
      if (stage === "during") controller.abort(reason);
      await expect(waiting).rejects.toMatchObject({
        _tag: "AnalysisCancelledError",
        operation: "inspect_adb_ui",
        cause: reason,
      });
      await waiting.catch((failure: unknown) => {
        expect(failure).toBeInstanceOf(AnalysisCancelledError);
        if (failure instanceof AnalysisCancelledError)
          expect(failure.cause).toBe(reason);
      });
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      predecessor.resolve(undefined);
      removed.mockRestore();
    }
  },
);

it("waits for the admitted predecessor before resolving without cancellation", async () => {
  const predecessor = createDeferred<void>();
  let completed = false;
  const waiting = awaitPredecessor(predecessor.promise, "inspect_adb_ui").then(
    () => {
      completed = true;
    },
  );
  await Promise.resolve();
  expect(completed).toBe(false);
  predecessor.resolve(undefined);
  await waiting;
  expect(completed).toBe(true);
});
