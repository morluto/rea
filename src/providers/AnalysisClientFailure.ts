import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisResourceConstraintError,
  reattributedResourceConstraint,
  AnalysisOutputError,
  AnalysisTimeoutError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  ArtifactReaderFailure,
  bindArtifactFileCleanup,
} from "../resources/index.js";

/** Copy authored outcome facts; semantic attribution never inspects a later signal. */
export const analysisClientFailureContext = (
  cause: AnalysisError,
  providerId: string,
  operation: string,
): AnalysisErrorOptions => {
  const providerRequest = cause.providerRequest()?.facts;
  const attribute = (
    recorded: Readonly<Record<string, JsonValue>> | undefined,
  ): Readonly<Record<string, JsonValue>> | undefined =>
    providerRequest === undefined
      ? recorded
      : {
          provider_request: providerRequest,
          ...(recorded === undefined ? {} : { provider_diagnostics: recorded }),
        };
  const diagnostics = attribute(cause.diagnostics);
  const invocationDiagnostics =
    cause.invocationDiagnostics === undefined
      ? undefined
      : attribute(cause.invocationDiagnostics);
  return {
    cause,
    ...(cause.limit === undefined ? {} : { limit: cause.limit }),
    ...(cause.related === undefined ? {} : { related: cause.related }),
    ...(cause.continuingCallerGuidance === undefined
      ? {}
      : { continuingCallerGuidance: cause.continuingCallerGuidance }),
    ...(cause.cleanupPrimary === undefined
      ? {}
      : {
          cleanupPrimary: analysisClientFailureForOperation(
            cause.cleanupPrimary,
            providerId,
            operation,
          ),
        }),
    ...(cause.partialObservation === undefined
      ? {}
      : { partialObservation: cause.partialObservation }),
    ...(cause.capturedOutput === undefined
      ? {}
      : { capturedOutput: cause.capturedOutput }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(invocationDiagnostics === undefined ? {} : { invocationDiagnostics }),
    ...(cause.cleanupIncomplete
      ? {
          cleanup: {
            reason: cause.cleanup?.reason ?? cause.message,
            resources: cause.cleanupResources,
          },
        }
      : {}),
  };
};

/** Attribute producer-owned failure facts without inferring interruption. */
export const analysisClientFailureForOperation = (
  cause: unknown,
  providerId: string,
  operation: string,
  callerDiagnostics?: Readonly<Record<string, JsonValue>>,
): AnalysisError => {
  if (!(cause instanceof AnalysisError)) {
    const failure = new ProviderAdapterError(providerId, operation, {
      cause,
      ...(callerDiagnostics === undefined
        ? {}
        : { diagnostics: callerDiagnostics }),
      ...(cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
        ? { cleanup: cause.cleanup }
        : {}),
    });
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
  const providerRequest = cause.providerRequest();
  if (
    providerRequest === undefined &&
    !(cause instanceof AnalysisCancelledError) &&
    !(cause instanceof ProviderAdapterError) &&
    !(cause instanceof AnalysisCapabilityUnavailableError) &&
    !(cause instanceof AnalysisAccessDeniedError) &&
    !(cause instanceof AnalysisArtifactChangedError) &&
    !(cause instanceof AnalysisTimeoutError) &&
    !(cause instanceof AnalysisOutputError) &&
    !(cause instanceof AnalysisResourceConstraintError)
  )
    return cause;
  const sourceContext = analysisClientFailureContext(
    cause,
    providerId,
    operation,
  );
  const context = {
    ...sourceContext,
    ...(callerDiagnostics === undefined
      ? {}
      : {
          diagnostics: { ...sourceContext.diagnostics, ...callerDiagnostics },
        }),
  };
  let result: AnalysisError;
  if (providerRequest !== undefined)
    result = providerRequest.reattribute(operation, context);
  else if (cause instanceof ProviderCleanupError) {
    const { diagnostics, ...outcomeContext } = context;
    result = new ProviderCleanupError(
      cause.providerId,
      cause.cleanupResources,
      diagnostics ?? {},
      {
        ...outcomeContext,
        operation,
        ...(cause.completedObservation === undefined
          ? {}
          : { completedObservation: cause.completedObservation }),
        ...(cause.remediationAction === undefined
          ? {}
          : { remediationAction: cause.remediationAction }),
      },
    );
  } else if (cause instanceof AnalysisTimeoutError)
    result = new AnalysisTimeoutError(operation, cause.timeoutMs, {
      ...context,
      ...(cause.elapsedMs === undefined ? {} : { elapsedMs: cause.elapsedMs }),
      ...(cause.targetBytes === undefined
        ? {}
        : { targetBytes: cause.targetBytes }),
      ...(cause.envName === undefined ? {} : { envName: cause.envName }),
      ...(cause.userMessage === undefined
        ? {}
        : { userMessage: cause.userMessage }),
      ...(cause.remediationAction === undefined
        ? {}
        : { remediationAction: cause.remediationAction }),
      ...(cause.limit === undefined ? {} : { limit: cause.limit }),
    });
  else if (cause instanceof AnalysisOutputError)
    result = new AnalysisOutputError(operation, cause.reason, {
      ...context,
      cleanupOnly: cause.cleanupOnly,
      ...(cause.userMessage === undefined
        ? {}
        : { userMessage: cause.userMessage }),
      ...(cause.remediationAction === undefined
        ? {}
        : { remediationAction: cause.remediationAction }),
    });
  else if (cause instanceof AnalysisCancelledError) {
    const { cause: _wrapped, ...cancellationContext } = context;
    result = cancelledBy(operation, cause, cancellationContext);
  } else if (cause instanceof AnalysisCapabilityUnavailableError)
    result = new AnalysisCapabilityUnavailableError(
      cause.providerId,
      operation,
      cause.reason,
      {
        ...context,
        ...(cause.userMessage === undefined
          ? {}
          : { userMessage: cause.userMessage }),
        ...(cause.remediationAction === undefined
          ? {}
          : { remediationAction: cause.remediationAction }),
        ...(cause.fallbackRemediationAction === undefined
          ? {}
          : { fallbackRemediationAction: cause.fallbackRemediationAction }),
        ...(cause.siblingOperations === undefined
          ? {}
          : { siblingOperations: cause.siblingOperations }),
        ...(cause.siblingReasons === undefined
          ? {}
          : { siblingReasons: cause.siblingReasons }),
        retryable: cause.retryable,
      },
    );
  else if (cause instanceof AnalysisAccessDeniedError)
    result = new AnalysisAccessDeniedError(
      operation,
      cause.path,
      cause.systemCode,
      context,
    );
  else if (cause instanceof AnalysisArtifactChangedError)
    result = new AnalysisArtifactChangedError(
      operation,
      cause.path,
      cause.reason,
      { ...context, integrityCheck: cause.integrityCheck },
    );
  else if (cause instanceof AnalysisResourceConstraintError)
    result = reattributedResourceConstraint(operation, cause, context);
  else if (cause instanceof ProviderAdapterError)
    result = new ProviderAdapterError(providerId, operation, {
      ...context,
      ...(cause.userMessage === undefined
        ? {}
        : { userMessage: cause.userMessage }),
      ...(cause.remediationAction === undefined
        ? {}
        : { remediationAction: cause.remediationAction }),
    });
  else return cause;
  for (const secondary of cause.secondaryFailures) {
    if (secondary instanceof AnalysisCancelledError)
      result = analysisErrorWithCancellation(result, secondary);
    else result.retainSecondaryFailure(secondary);
  }
  // The attributed error reads its source's cleanup: live resources while it
  // is pending, otherwise the source's completed release with the resources
  // kept as history.
  return cause.cleanupIncomplete
    ? result.bindCleanupDependencies([cause])
    : result.bindCleanupReleaseClaim({
        get cleanupReleased() {
          return !cause.cleanupIncomplete;
        },
      });
};
