import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";

/**
 * Wait for a predecessor operation to finish, or reject when the caller
 * cancels. The wait owns its abort listener for exactly its own lifetime, so a
 * cancelled caller never waits for a queued operation it already abandoned.
 */
export const awaitPredecessor = (
  predecessor: Promise<void>,
  operation: string,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        new AnalysisCancelledError(operation, {
          cause: signal?.reason,
        }),
      );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    void predecessor.then(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
  });
