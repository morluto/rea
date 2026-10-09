import { analysisErrorProjectionSchema } from "../contracts/errorSchemas.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, type Result } from "../domain/result.js";
import type { AnalysisExecution } from "./AnalysisProvider.js";
import type { BinarySession } from "./binary/BinarySession.js";
import { analysisErrorWithCleanupFailure } from "./binary/AnalysisClientCleanup.js";

/** Await one-shot cleanup and retain either the outcome or both failures. */
export const withSessionCleanup = async <Value>(
  session: BinarySession,
  operation: () => Promise<Value>,
  onCleanupFailure: (value: Value, error: AnalysisError) => Value,
): Promise<Value> => {
  let value: Value;
  try {
    value = await operation();
  } catch (cause: unknown) {
    const closed = await session.close();
    if (!closed.ok)
      throw new AggregateError(
        [cause, closed.error],
        "Analysis and provider cleanup both failed",
        { cause },
      );
    throw cause;
  }
  const closed = await session.close();
  return closed.ok ? value : onCleanupFailure(value, closed.error);
};

/** Keep the primary CLI failure or completed Evidence alongside cleanup failure. */
export const directAnalysisCleanupFailure = (
  output: JsonValue,
  error: AnalysisError,
): JsonValue => {
  const cleanup = projectAnalysisError(error);
  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    const { error: label, ...projection } = output;
    const primary = analysisErrorProjectionSchema.safeParse(projection);
    if (typeof label === "string" && primary.success)
      return {
        error: label,
        ...primary.data,
        code: "cleanup_incomplete",
        retryable: false,
        details: {
          ...primary.data.details,
          cleanup: "incomplete",
          resources: error.cleanupResources.slice(),
          execution_failure:
            primary.data.details !== undefined &&
            "execution_failure" in primary.data.details
              ? (primary.data.details.execution_failure ?? primary.data.code)
              : primary.data.code,
          primary_error: projection,
          cleanup_error: cleanup,
        },
      };
  }
  return {
    error: "Analysis failed",
    ...cleanup,
    code: "cleanup_incomplete",
    retryable: false,
    details: {
      ...cleanup.details,
      cleanup: "incomplete",
      partial_observation: output,
    },
  };
};

/** Preserve managed observations or the original typed failure in diagnostics. */
export const managedAnalysisCleanupFailure = (
  result: Result<AnalysisExecution, AnalysisError>,
  error: AnalysisError,
): Result<AnalysisExecution, AnalysisError> => {
  if (!result.ok)
    return err(analysisErrorWithCleanupFailure(result.error, error));
  const cleanup = projectAnalysisError(error);
  return err(
    new ProviderAdapterError(
      error instanceof ProviderAdapterError ? error.providerId : "rea",
      "close_binary",
      {
        cause: error,
        cleanup: { reason: cleanup.message, resources: error.cleanupResources },
        diagnostics: {
          cleanup_error: cleanup,
          partial_observation: jsonValueSchema.parse(result.value),
        },
      },
    ),
  );
};
