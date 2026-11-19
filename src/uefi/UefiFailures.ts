import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
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
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import type { UefiOperation } from "../domain/uefi/uefiFirmwareAnalysis.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";

/** Preserve retained worker diagnostics with their observed truncation status. */
export const capturedUefiOutput = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  truncated: snapshot.diagnosticTruncated === true,
});

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
  const cleanup =
    cause instanceof ArtifactReaderFailure ? cause.cleanup : undefined;
  const cleanupOptions = cleanup === undefined ? {} : { cleanup };
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof OwnedCommandFailure) {
    const outputOptions =
      cause.snapshot === null
        ? undefined
        : { capturedOutput: capturedUefiOutput(cause.snapshot) };
    if (cause.cleanupFailure !== null)
      return new ProviderAdapterError("rea-uefi", operation, {
        cause,
        diagnostics: {
          phase: "owned-worker-cleanup",
          reason: cause.cleanupFailure,
          ...(cause.snapshot === null
            ? {}
            : { captured_output: { ...capturedUefiOutput(cause.snapshot) } }),
        },
      });
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, {
        cause: cause.cancellation?.reason,
        ...outputOptions,
        ...cleanupOptions,
      });
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        operation,
        UEFI_FIRMWARE_LIMITS.timeoutMs,
        {
          cause,
          ...outputOptions,
          ...cleanupOptions,
        },
      );
    if (cause.reason === "output-limit")
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        cause.message,
        null,
        { cause, ...outputOptions },
      );
  }
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, {
        cause,
        ...cleanupOptions,
      });
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(operation, path, cause.message, {
        cause,
        ...cleanupOptions,
      });
    if (["limit", "path", "format"].includes(cause.reason))
      return new AnalysisInputError(operation, { cause, ...cleanupOptions }, [
        {
          path: ["path"],
          reason: cause.reason === "limit" ? "out_of_range" : "invalid_format",
          message: cause.message,
        },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, path, cause.code, {
        cause,
        ...cleanupOptions,
      });
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(operation, { cause, ...cleanupOptions }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected firmware image could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError("rea-uefi", operation, {
    cause,
    ...cleanupOptions,
    diagnostics: {
      phase: "unclassified",
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};
