import type { AbortedSignal } from "../domain/analysisErrorCore.js";

/**
 * Whether `cause` is the cancellation carrying `reason`: the reason itself, or
 * the `AbortError` (`ABORT_ERR`) that Node's signal-aware I/O rejects with,
 * which keeps the abort reason as its `cause`.
 */
export const isAbortWithReason = (cause: unknown, reason: unknown): boolean =>
  // Object.is: an abort reason may be NaN, which === never matches.
  Object.is(cause, reason) ||
  (cause instanceof Error &&
    cause.name === "AbortError" &&
    "code" in cause &&
    cause.code === "ABORT_ERR" &&
    Object.is(cause.cause, reason));

/**
 * Whether `cause` is this aborted signal's own cancellation, as raised by the
 * operation that observed the signal. An abort error carrying another reason
 * is not this caller's cancellation.
 */
export const isAbortOf = (
  cause: unknown,
  signal: AbortSignal | undefined,
): signal is AbortedSignal =>
  signal?.aborted === true && isAbortWithReason(cause, signal.reason);
