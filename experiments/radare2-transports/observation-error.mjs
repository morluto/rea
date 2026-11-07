import { AnalysisError } from "../../dist/domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../../dist/domain/analysisErrorCore.js";

// One composition boundary preserves typed failures and exact live cleanup
// links without changing the read owner's earlier observation.
export function observationError(
  cause,
  operation,
  message,
  partialObservation,
) {
  const producer =
    cause instanceof AnalysisError ? cause.partialObservation : undefined;
  const details = {
    cause,
    partialObservation:
      partialObservation === undefined
        ? producer
        : producer === undefined || producer === partialObservation
          ? partialObservation
          : { ...partialObservation, producer_observation: producer },
    ...(cause instanceof AnalysisError
      ? {
          diagnostics: cause.diagnostics,
          capturedOutput: cause.capturedOutput,
          ...(cause.cleanupIncomplete
            ? {
                cleanup: {
                  reason:
                    cause.cleanup?.reason ?? "Owned cleanup remains incomplete",
                  resources: cause.cleanupResources,
                },
              }
            : {}),
          ...(cause.cleanupPrimary ? { cleanupPrimary: cause } : {}),
        }
      : {}),
  };
  const error =
    cause instanceof AnalysisCancelledError
      ? new AnalysisCancelledError(cause.operation, {
          ...details,
          cause: cause.cause,
        })
      : cause instanceof AnalysisInputError
        ? new AnalysisInputError(
            cause.operation,
            { ...details, userMessage: cause.userMessage },
            cause.issues,
          )
        : cause instanceof AnalysisResourceConstraintError
          ? new AnalysisResourceConstraintError(
              cause.operation,
              cause.resource,
              cause.reason,
              cause.reportedLimits,
              {
                ...details,
                remediationAction: cause.remediationAction,
                retryable: cause.retryable,
              },
            )
          : cause instanceof AnalysisTimeoutError
            ? new AnalysisTimeoutError(
                cause.operation,
                cause.timeoutMs,
                details,
              )
            : cause instanceof AnalysisArtifactChangedError
              ? new AnalysisArtifactChangedError(
                  cause.operation,
                  cause.path,
                  cause.reason,
                  details,
                )
              : new AnalysisOutputError(operation, message, details);
  if (cause instanceof AnalysisError) error.bindCleanupDependencies([cause]);
  return error;
}
