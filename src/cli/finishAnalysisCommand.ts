import {
  finalizedResult,
  runOwned,
  type RecoveredCompletion,
} from "../providers/runOwned.js";
import type {
  AnalysisError,
  AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import {
  projectAnalysisError,
  projectAnalysisErrorWithoutCapturedOutput,
} from "../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { dispatchQueuedInterrupts } from "../process/queuedInterrupts.js";

/** Finish a one-shot CLI operation while retaining primary results through close. */
export const finishAnalysisCommand = async <
  Value extends AnalysisPartialObservation,
>(
  run: () => Promise<Result<Value, AnalysisError>>,
  service: { close(): Promise<void> },
  providerId: string,
  canonicalOperation: string,
  signal: AbortSignal,
  fallbackResource?: string,
  options: {
    readonly failureProjection?: "initial" | "final";
    /** Apply invocation-specific exclusions after all owned cleanup is composed. */
    readonly redactFailure?: (error: AnalysisError) => AnalysisError;
    /** Validate producer-attested completed output against this command's exact result contract. */
    readonly recoverCompletedObservation?: (
      observation: AnalysisPartialObservation,
    ) => Value | undefined;
    /** Recover a producer-specific completed result after its cleanup is confirmed. */
    readonly recoverResolvedCleanup?: (
      error: AnalysisError,
    ) => Value | undefined;
  } = {},
): Promise<Result<Value, ReturnType<typeof projectAnalysisError>>> => {
  // The command releases its provider resources and runtime before the caller
  // reads this result, so guidance needing a continuing session is omitted.
  const projectFailure = (error: AnalysisError) =>
    projectAnalysisError(options.redactFailure?.(error) ?? error, "invocation");
  // Some one-shot commands promise the original failure snapshot even when
  // close retries and mutates the producer's live cleanup status.
  let initialFailure: ReturnType<typeof projectAnalysisError> | undefined;
  let initialDiagnosticFailure: typeof initialFailure;
  let closeFailed = false;
  const finalized = await runOwned(run, {
    providerId,
    operation: canonicalOperation,
    signal,
    ...(fallbackResource === undefined ? {} : { fallbackResource }),
    partial: (value) => value,
    close: async () => {
      try {
        await service.close();
      } catch (cause) {
        closeFailed = true;
        throw cause;
      } finally {
        await dispatchQueuedInterrupts();
      }
    },
    inspectPrimary: (primary) => {
      if (primary.ok || options.failureProjection !== "initial") return;
      initialFailure = projectFailure(primary.error);
      initialDiagnosticFailure =
        primary.error.capturedOutput === undefined
          ? initialFailure
          : projectAnalysisErrorWithoutCapturedOutput(
              options.redactFailure?.(primary.error) ?? primary.error,
              "invocation",
            );
    },
    recoverCompleted: (
      primary,
      observed,
    ): RecoveredCompletion<Value> | undefined => {
      if (initialFailure !== undefined) return undefined;
      if (
        observed.cleanupResolvedByClose &&
        observed.cleanup.kind === "released"
      ) {
        const recovered = options.recoverResolvedCleanup?.(primary);
        if (recovered !== undefined) return { value: recovered };
      }
      if (
        primary instanceof ProviderCleanupError &&
        !primary.cleanupIncomplete &&
        primary.cleanupPrimary === undefined &&
        primary.completedObservation !== undefined
      ) {
        const completed = options.recoverCompletedObservation?.(
          primary.completedObservation,
        );
        if (completed !== undefined)
          return {
            value: completed,
            cancellationDiagnostics: {
              cleanup_history: projectFailure(primary),
            },
          };
      }
      return undefined;
    },
  });
  const result = finalizedResult(finalized);
  if (result.ok) return ok(result.value);
  const failure = projectFailure(result.error);
  if (initialFailure === undefined) return err(failure);
  if (!closeFailed) {
    // Close may mutate cleanup state, including resolving the cleanup of a
    // cancelled primary; preserve the snapshot and add later failures.
    const secondary = failure.details?.secondary_failures;
    return err(
      secondary === undefined
        ? initialFailure
        : {
            ...initialFailure,
            details: {
              ...initialFailure.details,
              secondary_failures: secondary,
            },
          },
    );
  }
  const diagnostics = failure.details?.diagnostics;
  return err({
    ...failure,
    details: {
      ...failure.details,
      diagnostics: {
        ...(typeof diagnostics === "object" &&
        diagnostics !== null &&
        !Array.isArray(diagnostics)
          ? diagnostics
          : {}),
        primary_error: initialDiagnosticFailure ?? initialFailure,
      },
    },
  });
};
