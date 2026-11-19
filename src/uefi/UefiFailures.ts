import { AnalysisCleanupLeaseGroup } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import type { UefiOperation } from "../domain/uefi/uefiFirmwareAnalysis.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";

/** Preserve retained worker diagnostics with their observed truncation status. */
const capturedUefiOutput = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  truncated: snapshot.diagnosticTruncated === true,
});

const cancelledOrTimedOut = (
  operation: UefiOperation,
  reason: unknown,
  options: AnalysisErrorOptions,
): AnalysisError => {
  if (reason instanceof AnalysisTimeoutError) {
    return new AnalysisTimeoutError(operation, reason.timeoutMs, {
      ...options,
      cause: reason,
    });
  }
  return new AnalysisCancelledError(operation, {
    ...options,
    cause: reason instanceof AnalysisCancelledError ? reason.cause : reason,
  });
};

/**
 * Keep artifact read, parser and owned-worker lifecycle failures distinct.
 * The UEFI lane is pure TypeScript plus one owned node worker per decode, so
 * there is no external-tool availability branch here.
 */
export const uefiFailure = (
  cause: unknown,
  operation: UefiOperation,
  path: string,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof OwnedCommandFailure) {
    const outputOptions =
      cause.snapshot === null
        ? cause.preparationFailure?.capturedOutput
        : capturedUefiOutput(cause.snapshot);
    const workerCleanup =
      cause.cleanupFailure === null
        ? undefined
        : {
            reason: cause.cleanupFailure,
            resources: cause.resources,
          };
    const workerOptions = {
      cause,
      capturedOutput: outputOptions,
      cleanup: workerCleanup,
    };
    if (cause.reason === "cancelled")
      return cancelledOrTimedOut(
        operation,
        cause.cancellation?.reason,
        workerOptions,
      );
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        operation,
        UEFI_FIRMWARE_LIMITS.timeoutMs,
        workerOptions,
      );
    if (workerCleanup !== undefined)
      return new ProviderAdapterError("rea-uefi", operation, {
        ...workerOptions,
        diagnostics: { phase: "owned-worker-cleanup" },
      });
    if (cause.reason === "output-limit")
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        cause.message,
        null,
        workerOptions,
      );
    return new ProviderAdapterError("rea-uefi", operation, {
      ...workerOptions,
      diagnostics: { phase: "owned-worker", reason: cause.message },
    });
  }
  if (cause instanceof DarwinProcessOwnershipInspectionError) {
    const options = { cause, capturedOutput: cause.capturedOutput };
    return cause.cancellation === undefined
      ? new ProviderAdapterError("rea-uefi", operation, {
          ...options,
          diagnostics: {
            phase: "owned-worker-preparation",
            reason: cause.message,
          },
        })
      : cancelledOrTimedOut(operation, cause.cancellation.reason, options);
  }
  if (cause instanceof ArtifactReaderFailure) {
    const options = {
      cause,
      cleanup: cause.cleanup,
      partialObservation: cause.partialObservation,
    };
    let error: AnalysisError;
    switch (cause.reason) {
      case "cancelled":
        error = cancelledOrTimedOut(
          operation,
          cause.cancellation?.reason,
          options,
        );
        break;
      case "integrity":
        error = new AnalysisArtifactChangedError(
          operation,
          path,
          cause.message,
          options,
        );
        break;
      case "limit":
      case "path":
      case "format":
        error = new AnalysisInputError(operation, options, [
          {
            path: ["path"],
            reason:
              cause.reason === "limit" ? "out_of_range" : "invalid_format",
            message: cause.message,
          },
        ]);
        break;
      default:
        error = new ProviderAdapterError("rea-uefi", operation, {
          ...options,
          diagnostics: { phase: "artifact", path, reason: cause.message },
        });
    }
    if (cause.cleanupLeases?.length)
      new AnalysisCleanupLeaseGroup(error, cause.cleanupLeases);
    return error;
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, path, cause.code, {
        cause,
      });
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected firmware image could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError("rea-uefi", operation, {
    cause,
    diagnostics: {
      phase: "unclassified",
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};
