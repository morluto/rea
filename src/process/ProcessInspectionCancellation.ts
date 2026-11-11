/** Recognize only cancellation attributed to this exact inspection signal. */
export const isProcessOwnershipInspectionCancellation = (
  cause: unknown,
  signal: AbortSignal | undefined,
): boolean =>
  signal?.aborted === true &&
  (cause === signal.reason ||
    (cause instanceof Error &&
      cause.name === "AbortError" &&
      cause.cause === signal.reason));
