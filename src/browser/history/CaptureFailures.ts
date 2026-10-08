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
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type InspectWebNetworkCaptureInput,
} from "../../domain/webNetworkCapture.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import { HAR_CAPTURE_HEAP_LIMITS } from "./CaptureRelease.js";
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
    if (
      phase === "decoder" &&
      input.format === "har" &&
      cause.reason === "process" &&
      cause.snapshot?.signal === "SIGABRT" &&
      /FATAL ERROR:[^\r\n]*heap out of memory/u.test(cause.snapshot.stderr.text)
    )
      return captureMemoryFailure(
        input,
        "The HAR decoder exhausted its fixed V8 heap",
        cause,
      );
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

/** Preserve a decoder's observed memory failure and its actual workload limits. */
export const captureMemoryFailure = (
  input: InspectWebNetworkCaptureInput,
  reason: string,
  cause?: unknown,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "memory",
    `${reason}: ${input.capture_path}. No complete capture result is available.`,
    {
      boundary: "historical-capture-decoder",
      capture_path: input.capture_path,
      format: input.format,
      maximum_input_bytes: WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
      maximum_reply_bytes: WEB_NETWORK_CAPTURE_LIMITS.outputBytes,
      ...(input.format === "har"
        ? {
            old_generation_heap_mib: HAR_CAPTURE_HEAP_LIMITS.oldGenerationMiB,
            semi_space_heap_mib: HAR_CAPTURE_HEAP_LIMITS.semiSpaceMiB,
          }
        : {}),
      ...(cause instanceof OwnedCommandFailure
        ? { observed_signal: cause.snapshot?.signal ?? null }
        : {}),
    },
    {
      cause,
      remediationAction: `Use a smaller capture exported by its producer, or another decoder with sufficient capacity for the original capture. Preserve the original for provenance; a subset does not establish complete-capture coverage.${input.format === "har" ? ` REA's HAR old-generation heap is fixed at ${HAR_CAPTURE_HEAP_LIMITS.oldGenerationMiB} MiB; inherited NODE_OPTIONS cannot raise it.` : ""}`,
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            capturedOutput: {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated: cause.snapshot.diagnosticTruncated ?? false,
            },
          }
        : {}),
    },
  );
