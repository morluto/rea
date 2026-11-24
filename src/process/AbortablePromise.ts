import type { Result } from "../domain/result.js";
import {
  cancelledBy,
  type CarriedCancellationReason,
} from "../domain/analysisErrorCore.js";

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

/** Join a retiring owner, preserving a reported failure even if the waiter has since aborted. */
export const waitForRetainedResult = async <Value, Failure>(
  pending: Promise<Result<Value, Failure>>,
  signal: AbortSignal | undefined,
): Promise<Result<Value, Failure> | AbortedWait> => {
  const observed = await waitForAbortable(pending, signal);
  if (observed instanceof AbortedWait || !observed.ok) return observed;
  return signal?.aborted ? new AbortedWait(signal.reason) : observed;
};

/**
 * Await the previous holder of a serialized command turn. A caller abort that
 * wins the wait becomes `operation`'s cancellation with the caller's reason.
 */
export const waitForCommandTurn = async (
  previous: Promise<void>,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<void> => {
  const outcome = await waitForAbortable(previous, signal);
  if (outcome instanceof AbortedWait) throw cancelledBy(operation, outcome);
};
