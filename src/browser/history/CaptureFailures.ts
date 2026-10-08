import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type InspectWebNetworkCaptureInput,
} from "../../domain/webNetworkCapture.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
const OPERATION = "inspect_web_network_capture";

/** Preserve the origin and typed cause of a historical capture failure. */
export const historicalCaptureFailure = (
  input: InspectWebNetworkCaptureInput,
  cause: unknown,
  phase: "capture-read" | "decoder",
  options?: ExecutionOptions,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof OwnedCommandFailure) {
    if (cause.cleanupFailure !== null)
      return new ProviderCleanupError(
        input.format,
        cause.resources,
        {
          reason: cause.cleanupFailure,
          previous_error: {
            failure_kind: cause.reason,
            message: cause.message,
            exit_code: cause.snapshot?.exitCode ?? null,
            signal: cause.snapshot?.signal ?? null,
            stdout: cause.snapshot?.stdout.text ?? null,
            stderr: cause.snapshot?.stderr.text ?? null,
            diagnostic_truncated: cause.snapshot?.diagnosticTruncated ?? null,
          },
        },
        { operation: OPERATION, cause },
      );
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(OPERATION);
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        OPERATION,
        WEB_NETWORK_CAPTURE_LIMITS.timeoutMs,
      );
    if (cause.reason === "output-limit")
      return new AnalysisOutputError(OPERATION, cause.message);
  }
  if (options?.signal?.aborted) return new AnalysisCancelledError(OPERATION);
  if (
    phase === "capture-read" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.capture_path,
      cause.message,
      { cause },
    );
  if (
    phase === "capture-read" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION);
  if (
    phase === "capture-read" &&
    cause instanceof ArtifactReaderFailure &&
    (cause.reason === "limit" ||
      cause.reason === "format" ||
      cause.reason === "path")
  )
    return new AnalysisInputError(OPERATION, { cause }, [
      {
        path: ["capture_path"],
        reason: cause.reason === "limit" ? "out_of_range" : "invalid_format",
        message:
          cause.reason === "limit"
            ? `${cause.message}. Select a capture within the ${WEB_NETWORK_CAPTURE_LIMITS.inputBytes}-byte input budget.`
            : cause.message,
        ...(cause.reason === "limit"
          ? {
              expected: {
                maximum_capture_bytes: WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
              },
            }
          : {}),
      },
    ]);
  if (
    phase === "capture-read" &&
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(
      OPERATION,
      input.capture_path,
      cause.code,
      { cause },
    );
  if (
    phase === "capture-read" &&
    cause instanceof Error &&
    "code" in cause &&
    ["ENOENT", "ENOTDIR"].includes(String(cause.code))
  )
    return new AnalysisInputError(OPERATION, { cause }, [
      {
        path: ["capture_path"],
        reason: "invalid_value",
        message: `Selected capture could not be read (${String(cause.code)}): ${input.capture_path}.`,
      },
    ]);
  return new ProviderAdapterError(input.format, OPERATION, {
    cause,
    diagnostics: {
      phase,
      capture_path: input.capture_path,
      reason: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof ArtifactReaderFailure
        ? { failure_kind: cause.reason }
        : {}),
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            exit_code: cause.snapshot.exitCode ?? null,
            signal: cause.snapshot.signal ?? null,
            stdout: cause.snapshot.stdout.text,
            stderr: cause.snapshot.stderr.text,
            diagnostic_truncated: cause.snapshot.diagnosticTruncated ?? false,
          }
        : {}),
    },
  });
};
