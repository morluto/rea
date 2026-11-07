import { ProviderAdapterError } from "./providerAdapterError.js";

/** An operation failed after the client confirmed release of all its resources. */
export class AnalysisCloseCompletedError extends ProviderAdapterError {}

/** A later cleanup dependency can revoke an earlier release observation. */
export const isCompletedCloseFailure = (
  error: unknown,
): error is AnalysisCloseCompletedError =>
  error instanceof AnalysisCloseCompletedError && !error.cleanupIncomplete;
