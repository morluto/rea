import type { JsonValue } from "./jsonValue.js";
import { ProviderAdapterError } from "./providerAdapterError.js";
import { ProviderCleanupError } from "./providerCleanupError.js";
import { childFailureDiagnostics } from "./analysisErrorProjection.js";
import type { AnalysisError } from "./analysisErrorBase.js";
import {
  analysisErrorUserMessage,
  composedCallerGuidance,
} from "./analysisErrorPresentation.js";

/**
 * Preserve the original lifecycle failure alongside incomplete cleanup. The
 * composite waits for an owner to bind its completion; compose with
 * `analysisErrorWithCleanupDependencies` when the parts own it.
 */
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
          omitRecovery: true,
          ...(primary.capturedOutput === undefined
            ? {}
            : { capturedOutput: "omit" as const }),
        },
        cleanup_error: { error: cleanup },
      }),
    },
  );

/**
 * Compose a failure with the cleanup failure that followed it. The composite
 * has no cleanup record of its own: it completes once the primary's and the
 * cleanup's records both report release, each read from its owner.
 */
export const analysisErrorWithCleanupDependencies = (
  primary: AnalysisError,
  cleanup: AnalysisError,
  operation = "close_binary",
): AnalysisError =>
  analysisErrorWithCleanupFailure(
    primary,
    cleanup,
    operation,
  ).bindCleanupDependencies([primary, cleanup]);

/**
 * Compose a failure with a close rejection whose completion may be unknown. A
 * rejection without a live cleanup record has unknown completion, not
 * confirmed release, so the composite binds its parts only while the rejection
 * is live. Otherwise it keeps its own pending record and never reads as
 * complete.
 */
export const analysisErrorWithCloseRejection = (
  primary: AnalysisError,
  rejection: AnalysisError,
  operation = "close_binary",
): AnalysisError =>
  rejection.cleanupIncomplete
    ? analysisErrorWithCleanupDependencies(primary, rejection, operation)
    : analysisErrorWithCleanupFailure(primary, rejection, operation);

/**
 * Compose two close rejections. Each may have unknown completion, so the
 * composite binds them only while both are live.
 */
export const analysisErrorWithCloseRejections = (
  first: AnalysisError,
  second: AnalysisError,
  operation = "close_binary",
): AnalysisError =>
  first.cleanupIncomplete
    ? analysisErrorWithCloseRejection(first, second, operation)
    : analysisErrorWithCleanupFailure(first, second, operation);

/**
 * Compose several cleanup failures into one provider cleanup failure. It lists
 * the parts' distinct resources and completes once every part reports release. Pass
 * `causes` to keep failures that are not AnalysisErrors in the aggregate
 * cause; only `failures` own completion.
 */
export const providerCleanupErrorFromFailures = (
  providerId: string,
  failures: readonly AnalysisError[],
  diagnostics: string | Readonly<Record<string, JsonValue>>,
  options: {
    readonly operation: string;
    readonly causes?: readonly unknown[];
    readonly message?: string;
  },
): ProviderCleanupError =>
  new ProviderCleanupError(
    providerId,
    [...new Set(failures.flatMap((failure) => failure.cleanupResources))],
    typeof diagnostics === "string" ? { reason: diagnostics } : diagnostics,
    {
      operation: options.operation,
      cause: new AggregateError(options.causes ?? failures, options.message),
    },
  ).bindCleanupDependencies(failures);

/** Compose rejected closes and follow known resource ownership independently of completion. */
export const providerCleanupErrorFromCloseRejections = (
  providerId: string,
  rejections: readonly {
    readonly cause: unknown;
    readonly cleanupOwner?: AnalysisError | undefined;
    readonly unconfirmedResources?: readonly string[];
  }[],
  diagnostics: Readonly<Record<string, JsonValue>>,
  options: {
    readonly operation: string;
    readonly message: string;
    readonly remediationAction?: string;
  },
): ProviderCleanupError => {
  const owners = rejections.flatMap(({ cleanupOwner }) =>
    cleanupOwner === undefined ? [] : [cleanupOwner],
  );
  const resources = () => [
    ...new Set(
      rejections.flatMap(({ cleanupOwner, unconfirmedResources }) => {
        if (cleanupOwner === undefined) return unconfirmedResources ?? [];
        return cleanupOwner.cleanupIncomplete
          ? cleanupOwner.cleanupResources
          : [];
      }),
    ),
  ];
  const aggregate = new ProviderCleanupError(
    providerId,
    resources(),
    diagnostics,
    {
      operation: options.operation,
      cause: new AggregateError(
        rejections.map(({ cause }) => cause),
        options.message,
      ),
      ...(options.remediationAction === undefined
        ? {}
        : { remediationAction: options.remediationAction }),
    },
  );
  if (owners.length === rejections.length)
    return aggregate.bindCleanupDependencies(owners);
  // Unconfirmed closes keep the aggregate pending. Known owners still account
  // for their own resources as those resources are released.
  if (owners.length > 0)
    aggregate.bindCleanupResourceOwner({
      get cleanupResources() {
        return resources();
      },
    });
  return aggregate;
};

/**
 * Follow an existing live owner's cleanup completion from a wrapper error while
 * keeping its released resource history empty once that owner finishes. If the
 * owner is not live (`!owner.cleanupIncomplete`), any pending cleanup on the
 * wrapper stays unknown.
 */
export const withInheritedCleanupOwnership = <Failure extends AnalysisError>(
  failure: Failure,
  owner: AnalysisError,
): Failure =>
  owner.cleanupIncomplete ? failure.bindCleanupDependencies([owner]) : failure;
