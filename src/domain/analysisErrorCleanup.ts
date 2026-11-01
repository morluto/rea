import { ProviderAdapterError } from "./providerAdapterError.js";
import { childFailureDiagnostics } from "./analysisErrorProjection.js";
import type { AnalysisError } from "./analysisErrorBase.js";
import {
  analysisErrorUserMessage,
  composedCallerGuidance,
} from "./analysisErrorPresentation.js";

/** Preserve the original lifecycle failure alongside incomplete cleanup. */
export const analysisErrorWithCleanupFailure = (
  primary: AnalysisError,
  cleanup: AnalysisError,
  operation = "close_binary",
): AnalysisError =>
  new ProviderAdapterError(
    cleanup instanceof ProviderAdapterError ? cleanup.providerId : "rea",
    operation,
    {
      cleanupPrimary: primary,
      cause: new AggregateError(
        [primary, cleanup],
        "Analysis failed and cleanup remains incomplete.",
        { cause: primary },
      ),
      // A retry offer belongs to the owner of the composed resources, if any.
      ...composedCallerGuidance({ message: primary, remediation: cleanup }),
      ...(primary.capturedOutput === undefined
        ? {}
        : { capturedOutput: primary.capturedOutput }),
      ...(primary.partialObservation === undefined
        ? {}
        : { partialObservation: primary.partialObservation }),
      cleanup: {
        reason:
          cleanup.cleanup?.reason ??
          analysisErrorUserMessage(cleanup, "invocation"),
        resources: [
          ...new Set([
            ...(primary.cleanupIncomplete ? primary.cleanupResources : []),
            ...cleanup.cleanupResources,
          ]),
        ],
      },
      ...childFailureDiagnostics({
        primary_error: {
          error: primary,
          ...(primary.capturedOutput === undefined
            ? {}
            : { capturedOutput: "omit" as const }),
        },
        cleanup_error: { error: cleanup },
      }),
    },
  );
