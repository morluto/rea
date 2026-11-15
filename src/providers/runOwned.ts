import {
  AnalysisCleanupLeaseGroup,
  type AnalysisCleanupLease,
} from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  AnalysisError,
  primaryAnalysisError,
  type AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import {
  AnalysisCancelledError,
  cancelledBy,
  isAborted,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";

/** What closing the work's owner established. */
export type CleanupOutcome =
  | { readonly kind: "released" }
  | { readonly kind: "retained"; readonly failure: AnalysisError };

/**
 * Work, owner cleanup and cancellation composed by one precedence rule:
 * - a recorded failure stays primary; a later cancellation is attached to it;
 * - cancellation observed before commit turns a completed value into a
 *   cancellation that keeps the value (see `CompletedValueRecord`);
 * - cancellation observed after commit keeps the completed value;
 * - unconfirmed cleanup never replaces the primary. A completed value whose
 *   cleanup is unconfirmed is a `cleanup_incomplete` error that keeps the
 *   value (the documented one-shot contract).
 */
export type Finalized<Value> =
  | {
      readonly kind: "completed";
      readonly value: Value;
      /** A cancellation observed after the commit cutoff. */
      readonly lateCancellation?: unknown;
    }
  | {
      readonly kind: "completed-cleanup-retained";
      readonly value: Value;
      readonly error: AnalysisError;
    }
  | {
      readonly kind: "cancelled";
      readonly error: AnalysisError;
      readonly cleanup: CleanupOutcome;
    }
  | {
      readonly kind: "failed";
      readonly error: AnalysisError;
      readonly cleanup: CleanupOutcome;
    };

/** A completed value recovered from a failure whose only cause was cleanup. */
export interface RecoveredCompletion<Value> {
  readonly value: Value;
  /** Diagnostics a later pre-commit cancellation carries, such as the resolved cleanup history. */
  readonly cancellationDiagnostics?: Readonly<Record<string, JsonValue>>;
}

/** The error that replaces a completed value and must keep it. */
export type CompletedValueReplacement = "cancellation" | "failure";

/**
 * How an error that replaces a completed value keeps it: as its partial
 * observation, or as diagnostics when the value is not an observation a
 * caller can recover. The replacement lets a producer keep a different
 * projection for a cancellation than for a cleanup or publication failure.
 */
export type CompletedValueRecord<Value> =
  | {
      readonly partial: (
        value: Value,
        replacedBy: CompletedValueReplacement,
      ) => AnalysisPartialObservation;
      readonly diagnostics?: never;
    }
  | {
      readonly diagnostics: (
        value: Value,
        replacedBy: CompletedValueReplacement,
      ) => Readonly<Record<string, JsonValue>>;
      readonly partial?: never;
    };

type KeptCompletion =
  | { readonly partialObservation: AnalysisPartialObservation }
  | { readonly diagnostics: Readonly<Record<string, JsonValue>> };

export type RunOwnedOptions<Value> = RunOwnedBaseOptions<Value> &
  CompletedValueRecord<Value>;

interface RunOwnedBaseOptions<Value> {
  readonly providerId: string;
  readonly operation: string;
  readonly signal?: AbortSignal | undefined;
  /** Releases everything the work acquired; awaited before the signal is read. */
  readonly close: () => Promise<void>;
  /** Names the owned resources when a non-REA close failure names none. */
  readonly fallbackResource?: string;
  /**
   * The exact leases whose confirmed release resolves a close failure; they
   * also attribute its resources. Omit them when close throws an error its
   * producer already bound, or an artifact reader failure that names its own
   * retained leases.
   */
  readonly cleanupLeases?: readonly AnalysisCleanupLease[];
  /**
   * Publishes a completed value. Cancellation observed before it runs cancels
   * the work; cancellation observed after it keeps the committed value.
   */
  readonly commit?: (value: Value) => Promise<void>;
  /** Observe the primary outcome before close may change its cleanup status. */
  readonly inspectPrimary?: (primary: Result<Value, AnalysisError>) => void;
  /** Recover a completed value from a primary failure after close settled. */
  readonly recoverCompleted?: (
    primary: AnalysisError,
    observed: {
      /** The primary reported unconfirmed cleanup before close and not after. */
      readonly cleanupResolvedByClose: boolean;
      readonly cleanup: CleanupOutcome;
    },
  ) => RecoveredCompletion<Value> | undefined;
}

const keepCompleted = <Value>(
  record: CompletedValueRecord<Value>,
  value: Value,
  replacedBy: CompletedValueReplacement,
): KeptCompletion =>
  record.partial === undefined
    ? { diagnostics: record.diagnostics(value, replacedBy) }
    : { partialObservation: record.partial(value, replacedBy) };

const retainCompleted = (
  error: AnalysisError,
  kept: KeptCompletion,
): AnalysisError =>
  "partialObservation" in kept
    ? error.retainPartialObservation(kept.partialObservation)
    : error.retainDiagnostics(kept.diagnostics);

const closeFailure = (
  cause: unknown,
  options: Pick<
    RunOwnedBaseOptions<unknown>,
    "providerId" | "operation" | "fallbackResource"
  >,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const observation =
    cause instanceof ArtifactReaderFailure
      ? ArtifactReaderFailure.cleanupObservation(
          cause,
          options.fallbackResource ?? `${options.operation} resources`,
        )
      : {
          reason: cause instanceof Error ? cause.message : String(cause),
          resources: [],
        };
  return new ProviderCleanupError(
    options.providerId,
    observation.resources,
    { reason: observation.reason },
    { cause, operation: options.operation },
  );
};

/** Run owned work, close its owner, and apply the finalization precedence once. */
export const runOwned = async <Value>(
  work: () => Promise<Result<Value, AnalysisError>>,
  options: RunOwnedOptions<Value>,
): Promise<Finalized<Value>> => {
  let primary: Result<Value, AnalysisError>;
  try {
    primary = await work();
  } catch (cause) {
    primary = {
      ok: false,
      error:
        cause instanceof AnalysisError
          ? cause
          : new ProviderAdapterError(options.providerId, options.operation, {
              cause,
            }),
    };
  }
  let committed = false;
  const commit = async (
    value: Value,
  ): Promise<Result<Value, AnalysisError>> => {
    try {
      await options.commit!(value);
      committed = true;
      return { ok: true, value };
    } catch (cause) {
      const kept = keepCompleted(options, value, "failure");
      return {
        ok: false,
        error:
          cause instanceof AnalysisError
            ? retainCompleted(cause, kept)
            : new ProviderAdapterError(options.providerId, options.operation, {
                cause,
                ...kept,
              }),
      };
    }
  };
  if (primary.ok && options.commit !== undefined && !isAborted(options.signal))
    primary = await commit(primary.value);
  options.inspectPrimary?.(primary);
  const hadIncompleteCleanup = !primary.ok && primary.error.cleanupIncomplete;
  let cleanup: CleanupOutcome = { kind: "released" };
  try {
    // Owners may resolve the primary's retained cleanup during close; only
    // they can confirm it, so its status is read again afterwards.
    await options.close();
  } catch (cause) {
    const failure = closeFailure(cause, options);
    const leases =
      options.cleanupLeases ??
      // A reader failure's leases are authoritative only for the cleanup it
      // reports.
      (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
        ? cause.cleanupLeases
        : undefined);
    if (leases !== undefined) new AnalysisCleanupLeaseGroup(failure, leases);
    cleanup = { kind: "retained", failure };
  }
  const signal = options.signal;
  let outcome:
    | {
        readonly ok: true;
        readonly value: Value;
        readonly diagnostics?: Readonly<Record<string, JsonValue>>;
      }
    | { readonly ok: false; readonly error: AnalysisError } = primary;
  if (!primary.ok) {
    if (isAborted(signal))
      analysisErrorWithCancellation(
        primary.error,
        cancelledBy(options.operation, signal),
      );
    const recovered = options.recoverCompleted?.(primary.error, {
      cleanupResolvedByClose:
        hadIncompleteCleanup && !primary.error.cleanupIncomplete,
      cleanup,
    });
    if (recovered !== undefined)
      outcome = {
        ok: true,
        value: recovered.value,
        ...(recovered.cancellationDiagnostics === undefined
          ? {}
          : { diagnostics: recovered.cancellationDiagnostics }),
      };
  }
  if (
    outcome.ok &&
    !primary.ok &&
    options.commit !== undefined &&
    !isAborted(signal)
  ) {
    const publication = await commit(outcome.value);
    if (!publication.ok) {
      // Publication is the last awaited step; a cancellation during it stays
      // attached to the publication failure without replacing it.
      outcome = publication;
      if (isAborted(signal))
        analysisErrorWithCancellation(
          publication.error,
          cancelledBy(options.operation, signal),
        );
    }
  }
  if (
    cleanup.kind === "released" &&
    !outcome.ok &&
    outcome.error.cleanupIncomplete
  )
    cleanup = { kind: "retained", failure: outcome.error };
  // The kind follows the primary failure, so a producer's composite whose
  // primary is a cancellation is cancelled, and a failure that only retains a
  // later cancellation as a secondary stays failed.
  let cancelled =
    !outcome.ok &&
    primaryAnalysisError(outcome.error) instanceof AnalysisCancelledError;
  if (outcome.ok && isAborted(signal)) {
    if (committed && cleanup.kind === "released")
      return {
        kind: "completed",
        value: outcome.value,
        lateCancellation: signal.reason,
      };
    if (!committed) {
      cancelled = true;
      const kept = keepCompleted(options, outcome.value, "cancellation");
      outcome = {
        ok: false,
        error: cancelledBy(
          options.operation,
          signal,
          "partialObservation" in kept
            ? {
                partialObservation: kept.partialObservation,
                ...(outcome.diagnostics === undefined
                  ? {}
                  : { diagnostics: outcome.diagnostics }),
              }
            : { diagnostics: { ...outcome.diagnostics, ...kept.diagnostics } },
        ),
      };
    }
  }
  if (cleanup.kind === "retained") {
    if (outcome.ok)
      return {
        kind: "completed-cleanup-retained",
        value: outcome.value,
        error: retainCompleted(
          cleanup.failure,
          keepCompleted(options, outcome.value, "failure"),
        ),
      };
    return {
      kind: cancelled ? "cancelled" : "failed",
      error:
        cleanup.failure === outcome.error
          ? outcome.error
          : analysisErrorWithCleanupFailure(
              outcome.error,
              cleanup.failure,
              options.operation,
            ).bindCleanupDependencies([outcome.error, cleanup.failure]),
      cleanup,
    };
  }
  if (outcome.ok) return { kind: "completed", value: outcome.value };
  return {
    kind: cancelled ? "cancelled" : "failed",
    error: outcome.error,
    cleanup,
  };
};

/** The single Result a caller sees for a finalized outcome. */
export const finalizedResult = <Value>(
  finalized: Finalized<Value>,
): Result<Value, AnalysisError> =>
  finalized.kind === "completed"
    ? { ok: true, value: finalized.value }
    : { ok: false, error: finalized.error };
