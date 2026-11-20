import type { CarriedCancellationReason } from "../domain/analysisErrorCore.js";

/**
 * An abortable wait that the signal won. It carries the signal's reason as
 * observed when the abort won, so `cancelledBy(operation, waited)` keeps that
 * reason without the consumer reading the signal again.
 */
export class AbortedWait implements CarriedCancellationReason {
  constructor(readonly carried: unknown) {}
}

/**
 * Await a promise without depending on the producer to observe cancellation.
 * The producer still receives its signal separately and remains responsible for
 * releasing any resources that it owns.
 */
export const waitForAbortable = async <Value>(
  pending: Promise<Value>,
  signal: AbortSignal | undefined,
): Promise<Value | AbortedWait> => {
  if (signal === undefined) return pending;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<AbortedWait>((resolve) => {
    if (signal.aborted) {
      resolve(new AbortedWait(signal.reason));
      return;
    }
    onAbort = () => resolve(new AbortedWait(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Even an already-cancelled wait must own the producer's eventual rejection.
    return await Promise.race([cancelled, pending]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
};
