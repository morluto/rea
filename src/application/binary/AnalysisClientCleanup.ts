import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { err, type Result } from "../../domain/result.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { AnalysisClient, ExecutionOptions } from "../AnalysisProvider.js";

/** Close one provider client and normalize unexpected adapter rejection. */
export const closeAnalysisClient = async (
  client: AnalysisClient,
  providerId: string,
  options: Pick<ExecutionOptions, "progress"> & {
    readonly retainDocument?: boolean;
  } = {},
): Promise<Result<null, AnalysisError>> => {
  try {
    return await client.close(options);
  } catch (cause: unknown) {
    // A typed cleanup failure already names its leftover resources.
    if (cause instanceof AnalysisError && cause.cleanupIncomplete)
      return err(cause);
    return err(
      new ProviderCleanupError(
        providerId,
        ["provider-client"],
        { reason: "provider client close rejected unexpectedly" },
        { cause },
      ),
    );
  }
};

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
        resources: cleanup.cleanupResources,
      },
      diagnostics: {
        primary_error: projectAnalysisError(primary),
        cleanup_error: projected,
      },
    },
  );
};
