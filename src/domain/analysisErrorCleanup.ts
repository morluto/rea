import { ProviderAdapterError } from "./providerAdapterError.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import type { AnalysisError } from "./analysisErrorBase.js";

/** Preserve the original lifecycle failure alongside incomplete cleanup. */
export const analysisErrorWithCleanupFailure = (
  primary: AnalysisError,
  cleanup: AnalysisError,
  operation = "close_binary",
): AnalysisError => {
  const projected = projectAnalysisError(cleanup);
  return new ProviderAdapterError(
    cleanup instanceof ProviderAdapterError ? cleanup.providerId : "rea",
    operation,
    {
      cause: primary,
      userMessage: projectAnalysisError(primary).message,
      ...(primary.capturedOutput === undefined
        ? {}
        : { capturedOutput: primary.capturedOutput }),
      ...(primary.partialObservation === undefined
        ? {}
        : { partialObservation: primary.partialObservation }),
      cleanup: {
        reason: projected.message,
        resources: [
          ...new Set([
            ...primary.cleanupResources,
            ...cleanup.cleanupResources,
          ]),
        ],
      },
      diagnostics: {
        primary_error: projectAnalysisError(primary),
        cleanup_error: projected,
      },
    },
  );
};
