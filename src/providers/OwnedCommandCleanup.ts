import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import {
  ProcessOwnershipInspectionCancelled,
  ProcessOwnershipIdentityBatchFailure,
} from "../process/ProcessInspectionCancellation.js";
import {
  processInspectionCleanupFailures,
  processInspectionCancellations,
  type ProcessInspectionFailure,
} from "../process/ProcessInspectionCleanup.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";

/** Transfer exact helper and command cleanup capabilities to the caller's scope. */
export const retainOwnedCommandCleanup = (
  cause: unknown,
  resourceOwner: RetainedResourceScope,
  providerId: string,
  operation: string,
): readonly AnalysisError[] => {
  const commandFailure =
    cause instanceof OwnedCommandFailure ? cause : undefined;
  const cleanups: AnalysisError[] = [];
  for (const preparation of processInspectionCleanupFailures(
    processInspectionFailure(cause),
  )) {
    const darwin = preparation instanceof DarwinProcessOwnershipInspectionError;
    const owner = darwin ? preparation.cleanupOwner : preparation.owner;
    const cleanup = darwin
      ? (preparation.cleanupFailure ??
        new ProviderCleanupError(
          providerId,
          ["process ownership inspection"],
          { reason: preparation.message },
          { cause: preparation, operation },
        ))
      : new ProviderCleanupError(
          providerId,
          [preparation.path],
          {
            reason:
              preparation.cleanupCause instanceof Error
                ? preparation.cleanupCause.message
                : String(preparation.cleanupCause),
          },
          { cause: preparation, operation },
        );
    cleanups.push(cleanup);
    // An observed cleanup failure without a transferred owner remains unresolved.
    if (owner === undefined) continue;
    const lease = new AnalysisCleanupLease(() => owner.close(), cleanup);
    lease.bindCleanupError(cleanup);
    resourceOwner.retain(
      {
        close: () => lease.release(),
        get cleanupResources() {
          return lease.released ? [] : cleanup.cleanupResources;
        },
      },
      cleanup.cleanupResources[0] ?? "process ownership inspection",
    );
  }
  if (
    commandFailure !== undefined &&
    (commandFailure.cleanupOwner !== undefined ||
      commandFailure.cleanupFailure !== null)
  ) {
    const supervisor = commandFailure.cleanupOwner;
    const failureForStop = (
      reason: string,
      result: OwnedCommandFailure["cleanupResult"],
    ): ProviderCleanupError =>
      new ProviderCleanupError(
        providerId,
        commandFailure.resources,
        {
          reason,
          ...(result === undefined
            ? {}
            : {
                process_cleanup: jsonValueSchema.parse(result),
              }),
        },
        { cause, operation },
      );
    const cleanup = failureForStop(
      commandFailure.cleanupFailure ??
        "Provider prerequisite cleanup remains incomplete",
      commandFailure.cleanupResult,
    );
    cleanups.push(cleanup);
    if (supervisor === undefined) return cleanups;
    const lease = new AnalysisCleanupLease(async () => {
      const stopped = await supervisor.stop();
      if (stopped.status === "incomplete") {
        const failure = failureForStop(stopped.reason, stopped.cleanupResult);
        failure.bindCleanupResourceOwner(lease);
        lease.bindCleanupError(failure);
        throw failure;
      }
    }, commandFailure.resources);
    cleanup.bindCleanupResourceOwner(lease);
    lease.bindCleanupError(cleanup);
    resourceOwner.retain(
      {
        close: () => lease.release(),
        get cleanupResources() {
          return cleanup.cleanupResources;
        },
      },
      commandFailure.resources[0] ?? "Provider prerequisite process",
    );
  }
  return cleanups;
};

/** A cancellation keeps its exact inspection record without exposing machine observations. */
export class ProcessInspectionAnalysisCancelledError extends AnalysisCancelledError {
  constructor(
    operation: string,
    readonly inspectionFailure: ProcessInspectionFailure,
    reason: unknown,
  ) {
    super(operation, {
      cause: reason,
      ...(inspectionFailure instanceof DarwinProcessOwnershipInspectionError &&
      inspectionFailure.capturedOutput !== undefined
        ? { capturedOutput: inspectionFailure.capturedOutput }
        : {}),
      ...(inspectionFailure instanceof ProcessOwnershipIdentityBatchFailure
        ? {
            diagnostics: {
              retained_observation_count: inspectionFailure.observations.size,
              rejected_request_count: inspectionFailure.failures.length,
            },
          }
        : {}),
    });
  }
}

export const processInspectionFailure = (
  cause: unknown,
): ProcessInspectionFailure | undefined => {
  const failure =
    cause instanceof OwnedCommandFailure ? cause.preparationFailure : cause;
  return failure instanceof ProcessOwnershipInspectionCancelled ||
    failure instanceof ProcessOwnershipIdentityBatchFailure ||
    failure instanceof DarwinProcessOwnershipInspectionError ||
    failure instanceof RegularFileCleanupFailure
    ? failure
    : undefined;
};

export const processInspectionCancellationError = (
  cause: unknown,
  operation: string,
): ProcessInspectionAnalysisCancelledError | undefined => {
  if (cause instanceof OwnedCommandFailure && cause.reason === "timeout")
    return undefined;
  const failure = processInspectionFailure(cause);
  if (failure instanceof DarwinProcessOwnershipInspectionError)
    return failure.cancellation === undefined
      ? undefined
      : new ProcessInspectionAnalysisCancelledError(
          operation,
          failure,
          failure.cancellation.reason,
        );
  if (
    failure instanceof ProcessOwnershipInspectionCancelled ||
    (failure instanceof ProcessOwnershipIdentityBatchFailure &&
      failure.origin === "cancelled")
  )
    return new ProcessInspectionAnalysisCancelledError(
      operation,
      failure,
      failure.reason,
    );
  return undefined;
};

/** Bind explicit inspection owners to an artifact scope while preserving the caller's primary. */
export const retainProcessInspectionCleanup = (
  cause: unknown,
  primary: AnalysisError,
  resources: ArtifactResourceScope,
  operation: string,
): AnalysisError => {
  const failures = retainOwnedCommandCleanup(
    cause,
    {
      retain: (owner, resource) =>
        resources.retain({
          kind: "lease",
          resource,
          lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
        }),
      run: (work) => work(),
    },
    "process-ownership",
    operation,
  );
  for (const failure of failures)
    primary = analysisErrorWithCleanupFailure(
      primary,
      failure,
      operation,
    ).bindCleanupDependencies([primary, failure]);
  return bindProcessInspectionCancellations(cause, primary, operation);
};

/** Project recorded cancellation facts without adopting cleanup a second time. */
export const bindProcessInspectionCancellations = (
  cause: unknown,
  primary: AnalysisError,
  operation: string,
): AnalysisError => {
  const preparation = processInspectionFailure(cause);
  if (
    preparation instanceof DarwinProcessOwnershipInspectionError &&
    preparation.capturedOutput !== undefined
  )
    primary.retainCapturedOutput(preparation.capturedOutput);
  if (preparation === undefined) return primary;
  for (const cancellation of processInspectionCancellations(preparation))
    primary = analysisErrorWithCancellation(
      primary,
      new ProcessInspectionAnalysisCancelledError(
        operation,
        preparation,
        cancellation.reason,
      ),
    );
  return primary;
};
