import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  ArtifactReaderFailure,
} from "../resources/index.js";
import {
  AnalysisError,
  primaryAnalysisError,
  type AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
  cancelledBy,
  isAborted,
  OwnerCancellation,
  type AnalysisTimeoutRecovery,
} from "../domain/analysisErrorCore.js";
import type { Deadline } from "../domain/deadline.js";
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
 *   value (the documented one-shot contract);
 * - an elapsed work budget is a timeout, not a cancellation, and keeps a
 *   completed value the way a pre-commit cancellation does; a caller abort
 *   stays a cancellation even when the budget also elapsed.
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
  /**
   * Bounds the work by its work budget and `close` by its finalize budget.
   * The work's signal aborts with `OwnerCancellation.deadlineElapsed` when the
   * work budget elapses, and the outcome is an `AnalysisTimeoutError`. A
   * close that outlasts the finalize budget leaves cleanup incomplete: the
   * leases stay retained (or, without leases, the close still running is the
   * lease) and their confirmed release later resolves it. Publication
   * (`commit`) is outside both budgets.
   */
  readonly deadline?: Deadline | undefined;
  /**
   * The provider's recovery for an elapsed work budget, carried by the
   * `AnalysisTimeoutError` that budget produces. Its diagnostics are added to
   * the ones the replaced outcome recorded. Without it the timeout names only
   * the operation and its work budget.
   */
  readonly timeoutRecovery?: AnalysisTimeoutRecovery | undefined;
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

/** The work's signal: the caller's, plus the work budget when one is set. */
const boundWork = (
  signal: AbortSignal | undefined,
  deadline: Deadline | undefined,
): {
  readonly signal: AbortSignal | undefined;
  readonly elapsed: () => boolean;
  readonly stop: () => void;
} => {
  if (deadline === undefined)
    return { signal, elapsed: () => false, stop: () => undefined };
  const budget = new AbortController();
  // A budget that elapsed before work starts is already aborted, so the work
  // never sees a live signal it cannot finish under.
  if (deadline.expired()) budget.abort(OwnerCancellation.deadlineElapsed);
  const timer = setTimeout(
    () => budget.abort(OwnerCancellation.deadlineElapsed),
    deadline.remainingMs(),
  );
  return {
    signal:
      signal === undefined
        ? budget.signal
        : AbortSignal.any([signal, budget.signal]),
    // Work that settles without yielding to the timer still overran the
    // budget when the monotonic deadline has passed.
    elapsed: () => budget.signal.aborted || deadline.expired(),
    stop: () => clearTimeout(timer),
  };
};

/**
 * Await close within the finalize budget. When the budget elapses first, the
 * close keeps running and the returned failure stays incomplete until the
 * exact leases (or, without them, that close) confirm release.
 */
const closeWithin = async (
  options: Pick<
    RunOwnedBaseOptions<unknown>,
    | "close"
    | "deadline"
    | "cleanupLeases"
    | "providerId"
    | "operation"
    | "fallbackResource"
  >,
): Promise<AnalysisError | undefined> => {
  const closing = options.close();
  const deadline = options.deadline;
  if (deadline === undefined) {
    await closing;
    return undefined;
  }
  const finalize = deadline.beginFinalize();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), finalize.remainingMs());
  });
  try {
    if ((await Promise.race([closing, expired])) !== "expired")
      return undefined;
  } finally {
    clearTimeout(timer);
  }
  // Without exact leases, the close still running is the lease: its success
  // confirms release.
  const supplied =
    options.cleanupLeases !== undefined && options.cleanupLeases.length > 0
      ? options.cleanupLeases
      : undefined;
  const leases = supplied ?? [
    new AnalysisCleanupLease(
      () => closing,
      [options.fallbackResource ?? `${options.operation} resources`],
    ),
  ];
  const resources = leases.flatMap((lease) => lease.cleanupResources ?? []);
  const failure = new ProviderCleanupError(
    options.providerId,
    resources.length > 0
      ? resources
      : [options.fallbackResource ?? `${options.operation} resources`],
    {
      reason: `Cleanup did not finish within its ${String(finalize.workMs)} ms finalize budget`,
    },
    { operation: options.operation },
  );
  new AnalysisCleanupLeaseGroup(failure, leases);
  if (supplied === undefined) {
    // A late rejection names its own retry owner: a producer-bound error, or
    // an artifact reader failure with its leases. Completion and resource
    // attribution then follow that owner, the same way an in-budget close
    // failure would; an unattributed rejection keeps the close's fallback.
    let late: AnalysisError | undefined;
    failure.bindCleanupReleaseClaim({
      get cleanupReleased() {
        return late !== undefined && !late.cleanupIncomplete;
      },
    });
    void leases[0]!.release().catch((cause: unknown) => {
      const rejection = closeFailure(cause, options);
      const readerLeases =
        cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
          ? cause.cleanupLeases
          : undefined;
      if (readerLeases !== undefined)
        new AnalysisCleanupLeaseGroup(rejection, readerLeases);
      // A rejection that carries no cleanup of its own (such as a
      // cancellation) names no owner: the close's lease stays unreleased. One
      // whose owner already released (a retry finished first) still names it.
      if (!rejection.carriesCleanup) return;
      late = rejection;
      if (cause instanceof AnalysisError || readerLeases !== undefined)
        failure.bindCleanupResourceOwner(rejection);
    });
  } else void closing.catch(() => undefined);
  return failure;
};

/** Run owned work, close its owner, and apply the finalization precedence once. */
export const runOwned = async <Value>(
  work: (
    signal: AbortSignal | undefined,
  ) => Promise<Result<Value, AnalysisError>>,
  options: RunOwnedOptions<Value>,
): Promise<Finalized<Value>> => {
  const bound = boundWork(options.signal, options.deadline);
  let primary: Result<Value, AnalysisError>;
  try {
    primary = await work(bound.signal);
  } catch (cause) {
    primary = {
      ok: false,
      error:
        cause instanceof AnalysisError
          ? cause
          : // The budget's abort is this boundary's own typed reason, so work
            // that throws it (throwIfAborted) observed the budget. A caller's
            // reason is opaque and never classifies a thrown value.
            bound.elapsed() && cause === OwnerCancellation.deadlineElapsed
            ? cancelledBy(options.operation, OwnerCancellation.deadlineElapsed)
            : new ProviderAdapterError(options.providerId, options.operation, {
                cause,
              }),
    };
  }
  bound.stop();
  // A caller abort stays a cancellation even when the budget also elapsed.
  // Budget expiry is tracked apart from the caller: the caller may abort
  // after the budget did, and its reason still takes precedence below.
  const budgetElapsed = bound.elapsed();
  const workTimedOut = budgetElapsed && !isAborted(options.signal);
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
  if (
    primary.ok &&
    options.commit !== undefined &&
    !isAborted(options.signal) &&
    !workTimedOut
  )
    primary = await commit(primary.value);
  options.inspectPrimary?.(primary);
  const hadIncompleteCleanup = !primary.ok && primary.error.cleanupIncomplete;
  let cleanup: CleanupOutcome = { kind: "released" };
  try {
    // Owners may resolve the primary's retained cleanup during close; only
    // they can confirm it, so its status is read again afterwards.
    const unfinished = await closeWithin(options);
    if (unfinished !== undefined)
      cleanup = { kind: "retained", failure: unfinished };
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
    !isAborted(signal) &&
    !workTimedOut
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
  // Whether this outcome is the work's own observation of the budget's abort.
  const budgetCancellation = (error: AnalysisError): boolean => {
    const primaryError = primaryAnalysisError(error);
    return (
      primaryError instanceof AnalysisCancelledError &&
      primaryError.cause === OwnerCancellation.deadlineElapsed
    );
  };
  // A replacement keeps the failures the replaced error recorded, and its
  // live cleanup as its own dependency, so neither is lost.
  const replacing = (
    replaced: AnalysisError,
    replacement: AnalysisError,
  ): AnalysisError => {
    for (const secondary of new Set([
      ...replaced.secondaryFailures,
      ...primaryAnalysisError(replaced).secondaryFailures,
    ]))
      replacement.retainSecondaryFailure(secondary);
    return replaced.cleanupIncomplete
      ? analysisErrorWithCleanupDependencies(
          replacement,
          replaced,
          options.operation,
        )
      : replacement;
  };
  if (budgetElapsed && isAborted(signal)) {
    // The caller aborted after the budget, during work or cleanup: a caller
    // abort stays a cancellation, and its reason replaces the budget's. A
    // late completed value becomes that cancellation below, as any
    // pre-commit cancellation does.
    if (!outcome.ok && budgetCancellation(outcome.error))
      outcome = {
        ok: false,
        error: replacing(
          outcome.error,
          cancelledBy(options.operation, signal, {
            ...(outcome.error.partialObservation === undefined
              ? {}
              : { partialObservation: outcome.error.partialObservation }),
            ...(outcome.error.diagnostics === undefined
              ? {}
              : { diagnostics: outcome.error.diagnostics }),
            ...(outcome.error.capturedOutput === undefined
              ? {}
              : { capturedOutput: outcome.error.capturedOutput }),
          }),
        ),
      };
  } else if (workTimedOut && options.deadline !== undefined) {
    const timeout = (
      replaced: Partial<
        Pick<
          AnalysisError,
          "partialObservation" | "diagnostics" | "capturedOutput"
        >
      >,
      cause?: unknown,
    ): AnalysisTimeoutError => {
      const recovery = options.timeoutRecovery ?? {};
      const diagnostics =
        replaced.diagnostics === undefined || recovery.diagnostics === undefined
          ? (recovery.diagnostics ?? replaced.diagnostics)
          : { ...replaced.diagnostics, ...recovery.diagnostics };
      return new AnalysisTimeoutError(
        options.operation,
        options.deadline!.workMs,
        {
          ...recovery,
          ...(cause === undefined ? {} : { cause }),
          ...(replaced.partialObservation === undefined
            ? {}
            : { partialObservation: replaced.partialObservation }),
          ...(diagnostics === undefined ? {} : { diagnostics }),
          ...(replaced.capturedOutput === undefined
            ? {}
            : { capturedOutput: replaced.capturedOutput }),
        },
      );
    };
    if (outcome.ok && !committed) {
      // The value arrived after the budget elapsed and was not published.
      const kept = keepCompleted(options, outcome.value, "failure");
      outcome = {
        ok: false,
        error: timeout(
          "partialObservation" in kept
            ? { partialObservation: kept.partialObservation }
            : { diagnostics: { ...outcome.diagnostics, ...kept.diagnostics } },
        ),
      };
    } else if (!outcome.ok && budgetCancellation(outcome.error))
      // The work observed the budget's abort; that cancellation is the
      // timeout's cause, and the cleanup it retains stays bound.
      outcome = {
        ok: false,
        error: replacing(outcome.error, timeout(outcome.error, outcome.error)),
      };
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
          : analysisErrorWithCleanupDependencies(
              outcome.error,
              cleanup.failure,
              options.operation,
            ),
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
