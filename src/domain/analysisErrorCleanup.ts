import { ProviderAdapterError } from "./providerAdapterError.js";
import {
  projectAnalysisError,
  projectAnalysisErrorForCleanupHistory,
} from "./analysisErrorProjection.js";
import type { AnalysisError } from "./analysisErrorBase.js";
import { analysisErrorRemediationAction } from "./analysisErrorPresentation.js";

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
      cleanupPrimary: primary,
      cause: new AggregateError(
        [primary, cleanup],
        "Analysis failed and cleanup remains incomplete.",
        { cause: primary },
      ),
      userMessage: projectAnalysisError(primary).message,
      // A retry offer belongs to the owner of the composed resources, if any.
      remediationAction: analysisErrorRemediationAction(cleanup),
      ...(primary.capturedOutput === undefined
        ? {}
        : { capturedOutput: primary.capturedOutput }),
      ...(primary.partialObservation === undefined
        ? {}
        : { partialObservation: primary.partialObservation }),
      cleanup: {
        reason: cleanup.cleanup?.reason ?? projected.message,
        resources: [
          ...new Set([
            ...(primary.cleanupIncomplete ? primary.cleanupResources : []),
            ...cleanup.cleanupResources,
          ]),
        ],
      },
      diagnostics: {
        primary_error: projectAnalysisErrorForCleanupHistory(primary),
        cleanup_error: projected,
      },
    },
  );
};
