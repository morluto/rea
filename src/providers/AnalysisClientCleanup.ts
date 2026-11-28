import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, type Result } from "../domain/result.js";
import {
  AnalysisError,
  type AnalysisCleanupReleaseClaim,
} from "../domain/analysisErrorBase.js";
import type { AnalysisClient } from "../ports/AnalysisProvider.js";
import type { EngineCloseReport } from "../domain/engineCloseReport.js";

/** Close one provider client and normalize unexpected adapter rejection. */
export const closeAnalysisClient = async (
  client: AnalysisClient,
  providerId: string,
  options: Parameters<AnalysisClient["close"]>[0] = {},
  closeRejectionRelease?: AnalysisCleanupReleaseClaim,
): Promise<Result<EngineCloseReport | null, AnalysisError>> => {
  // Nested/composite clients report failures before their final result settles.
  // Own notification identity for this close attempt, including the fallback
  // for clients that only return or reject with their cleanup failure.
  const reported = new Set<AnalysisError>();
  const report = (failure: AnalysisError): void => {
    if (reported.has(failure)) return;
    reported.add(failure);
    options.onCleanupFailure?.(failure);
  };
  let result: Result<EngineCloseReport | null, AnalysisError>;
  try {
    result = await client.close({
      ...options,
      ...(options.onCleanupFailure === undefined
        ? {}
        : { onCleanupFailure: report }),
    });
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError && cause.cleanupIncomplete) {
      result = err(cause);
    } else {
      // An unexpected rejection cannot attest this close's completion. A
      // caller that retains the client can supply its own retry release.
      const failure = new ProviderCleanupError(
        providerId,
        ["provider-client"],
        { reason: "provider client close rejected unexpectedly" },
        { cause },
      );
      if (closeRejectionRelease !== undefined)
        failure.bindCleanupReleaseClaim(closeRejectionRelease);
      result = err(failure);
    }
  }
  if (!result.ok) report(result.error);
  return result;
};
