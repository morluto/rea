import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { WABT_LIMITS, WABT_PROVIDER_IDENTITY } from "./WabtRelease.js";
/** Preserve lifecycle failures and diagnostic bytes instead of returning partial success. */
export const wabtFailure = (
  cause: unknown,
  phase: "configuration" | "artifact" | "producer",
  path: string,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  if (
    (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled") ||
    (cause instanceof Error && cause.name === "AbortError")
  )
    return new AnalysisCancelledError("inspect_wasm_artifact", { cause });
  if (cause instanceof OwnedCommandFailure) {
    const capturedOutput =
      cause.snapshot === null
        ? undefined
        : {
            stdout: cause.snapshot.stdout.text,
            stderr: cause.snapshot.stderr.text,
            truncated: cause.snapshot.diagnosticTruncated ?? false,
          };
    const options =
      capturedOutput === undefined ? { cause } : { cause, capturedOutput };
    if (cause.cleanupFailure !== null)
      return new ProviderCleanupError(
        WABT_PROVIDER_IDENTITY.id,
        cause.resources,
        {
          reason: cause.cleanupFailure,
          previous_error: reason,
          ...(capturedOutput === undefined
            ? {}
            : { captured_output: capturedOutput }),
        },
        { operation: "inspect_wasm_artifact", cause },
      );
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError("inspect_wasm_artifact", options);
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        "inspect_wasm_artifact",
        WABT_LIMITS.timeoutMs,
        options,
      );
    if (phase === "configuration" && cause.reason === "process")
      return new AnalysisCapabilityUnavailableError(
        WABT_PROVIDER_IDENTITY.id,
        "inspect_wasm_artifact",
        reason,
        {
          ...options,
          userMessage:
            "Configured WABT could not start. Check executable/interpreter access and WABT 1.0.42 profile; inspect retained diagnostics.",
        },
      );
    return new AnalysisOutputError("inspect_wasm_artifact", reason, options);
  }
  if (phase === "configuration")
    return new AnalysisCapabilityUnavailableError(
      WABT_PROVIDER_IDENTITY.id,
      "inspect_wasm_artifact",
      reason,
      {
        cause,
        userMessage: `${reason} Supply WABT 1.0.42 via absolute REA_WABT_BIN_DIRECTORY; REA does not install tools.`,
      },
    );
  if (
    phase === "artifact" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      "inspect_wasm_artifact",
      path,
      reason,
      { cause },
    );
  if (
    phase === "artifact" &&
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(
      "inspect_wasm_artifact",
      path,
      cause.code,
      { cause },
    );
  if (phase === "artifact")
    return new AnalysisInputError("inspect_wasm_artifact", { cause }, [
      { path: ["path"], reason: "invalid_value", message: reason },
    ]);
  return new AnalysisOutputError("inspect_wasm_artifact", reason, { cause });
};
