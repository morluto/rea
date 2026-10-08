import type { EvmWorkerLimits } from "./EvmWorkerLimits.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import {
  EVMOLE_PROVIDER_IDENTITY,
  EVM_INTERFACE_LIMITS,
  EVM_FILE_SIZE_FAILURE_EXIT,
} from "./EvmoleRelease.js";

/** Correlate a reserved exit with the owned worker's actual failure branch. */
export interface EvmFileSizeFailureEvidence {
  readonly verified: boolean;
  readonly failure: string | null;
}

/** Keep carrier read, engine and owned lifecycle failures distinct. */
export const evmInterfaceFailure = (
  cause: unknown,
  phase: "configuration" | "artifact-read" | "worker",
  path: string,
  workerLimits?: EvmWorkerLimits,
  limiter = "/usr/bin/prlimit",
  fileFailure?: EvmFileSizeFailureEvidence,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof OwnedCommandFailure) {
    const outputOptions =
      cause.snapshot === null
        ? undefined
        : { capturedOutput: capturedEvmOutput(cause.snapshot) };
    if (cause.cleanupFailure !== null)
      return new ProviderCleanupError(
        EVMOLE_PROVIDER_IDENTITY.id,
        cause.resources,
        {
          reason: cause.cleanupFailure,
          ...(cause.snapshot === null
            ? {}
            : { captured_output: { ...capturedEvmOutput(cause.snapshot) } }),
          previous_error: {
            failure_kind: cause.reason,
            message: cause.message,
            exit_code: cause.snapshot?.exitCode ?? null,
            signal: cause.snapshot?.signal ?? null,
            stdout: cause.snapshot?.stdout.text ?? null,
            stderr: cause.snapshot?.stderr.text ?? null,
          },
        },
        { operation: "inspect_evm_interface", cause },
      );
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError("inspect_evm_interface", outputOptions);
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        "inspect_evm_interface",
        EVM_INTERFACE_LIMITS.timeoutMs,
        outputOptions,
      );
    if (cause.reason === "output-limit")
      return new AnalysisOutputError(
        "inspect_evm_interface",
        cause.message,
        outputOptions,
      );
    if (
      cause.reason === "process" &&
      (cause.snapshot?.signal === "SIGXCPU" ||
        cause.snapshot?.signal === "SIGXFSZ" ||
        (fileFailure?.verified === true &&
          cause.snapshot?.exitCode === EVM_FILE_SIZE_FAILURE_EXIT &&
          cause.snapshot.signal === null))
    )
      return new AnalysisResourceConstraintError(
        "inspect_evm_interface",
        cause.snapshot.signal === "SIGXCPU" ? "cpu" : "file-size",
        (cause.snapshot.signal === null
          ? "Owned EVM worker reported EFBIG while writing its reply; the exact write failure cause is unknown."
          : `Owned EVM command terminated with ${cause.snapshot.signal}; the exact signal cause is unknown.`) +
          " Effective worker limits are unknown. Configured soft limits are retained separately.",
        workerLimits === undefined
          ? null
          : {
              configured_soft_limits: {
                address_space_bytes: workerLimits.addressSpaceBytes,
                cpu_seconds: workerLimits.cpuSeconds,
                file_size_bytes: workerLimits.fileSizeBytes,
              },
              effective_soft_limits: null,
            },
        outputOptions,
      );
  }
  if (
    cause instanceof Error &&
    "code" in cause &&
    "syscall" in cause &&
    typeof cause.syscall === "string" &&
    cause.syscall.startsWith("spawn ")
  ) {
    const reason = `Configured util-linux prlimit could not launch (${String(cause.code)}): ${limiter}. Check its executable/interpreter and host execute access.`;
    return new AnalysisCapabilityUnavailableError(
      EVMOLE_PROVIDER_IDENTITY.id,
      "inspect_evm_interface",
      reason,
      { cause, userMessage: reason },
    );
  }
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError("inspect_evm_interface");
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(
        "inspect_evm_interface",
        path,
        cause.message,
        { cause },
      );
    if (
      phase === "artifact-read" &&
      ["limit", "path", "format"].includes(cause.reason)
    )
      return new AnalysisInputError("inspect_evm_interface", { cause }, [
        {
          path: ["path"],
          reason: cause.reason === "limit" ? "out_of_range" : "invalid_format",
          message: cause.message,
        },
      ]);
  }
  if (phase === "artifact-read" && cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(
        "inspect_evm_interface",
        path,
        cause.code,
        { cause },
      );
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError("inspect_evm_interface", { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected bytecode carrier could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(
    EVMOLE_PROVIDER_IDENTITY.id,
    "inspect_evm_interface",
    {
      cause,
      diagnostics: {
        phase,
        path,
        ...(workerLimits === undefined
          ? {}
          : { configured_resource_limits: { ...workerLimits } }),
        reason: cause instanceof Error ? cause.message : String(cause),
        ...(fileFailure === undefined
          ? {}
          : { file_size_failure_marker: { ...fileFailure } }),
        ...(cause instanceof OwnedCommandFailure
          ? {
              failure_kind: cause.reason,
              exit_code: cause.snapshot?.exitCode ?? null,
              signal: cause.snapshot?.signal ?? null,
              stdout: cause.snapshot?.stdout.text ?? null,
              stderr: cause.snapshot?.stderr.text ?? null,
              ...(cause.snapshot === null
                ? {}
                : {
                    captured_output: { ...capturedEvmOutput(cause.snapshot) },
                  }),
            }
          : {}),
      },
    },
  );
};

/** Preserve retained worker diagnostics with their observed truncation status. */
export const capturedEvmOutput = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  truncated: snapshot.diagnosticTruncated === true,
});
