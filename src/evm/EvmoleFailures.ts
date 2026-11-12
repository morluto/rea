import type { EvmWorkerLimits } from "./EvmWorkerLimits.js";
import {
  ArtifactReaderFailure,
  selectedPathRefusal,
} from "../artifacts/ArtifactReader.js";
import {
  artifactFileCancellationCause,
  artifactSelectedPathErrno,
} from "../artifacts/ArtifactFileOperation.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisErrorOptions,
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
  DEFAULT_EVM_TIMEOUT_MS,
  MAX_EVM_TIMEOUT_MS,
  selectedEvmProducerLimits,
  evmProducerLimitRecovery,
  type EvmProducerLimits,
} from "../domain/evm/evmInterface.js";
import { EVM_FILE_SIZE_FAILURE_EXIT } from "./EvmoleRelease.js";
import { EVMOLE_PROVIDER_IDENTITY } from "./EvmoleProviderIdentity.js";

/** Both a structured worker refusal and reply-file admission name this allowance. */
export const evmReplyBudgetFailure = (
  reason: string,
  options: AnalysisErrorOptions,
  limits: EvmProducerLimits = selectedEvmProducerLimits(undefined),
) =>
  new AnalysisResourceConstraintError(
    "inspect_evm_interface",
    "file-size",
    reason,
    {
      maximum_reply_bytes: limits.output_bytes,
      parameter: "producer_limits.output_bytes",
    },
    {
      ...options,
      retryable: false,
      remediationAction: evmProducerLimitRecovery(limits, "output_bytes"),
    },
  );

const evmTimeoutRecovery = (timeoutMs: number): string =>
  `${
    timeoutMs < MAX_EVM_TIMEOUT_MS
      ? `Increase timeout_ms above ${String(timeoutMs)} (integer milliseconds, maximum ${String(MAX_EVM_TIMEOUT_MS)}), or use rea inspect-evm-interface <path> <encoding> --timeout-ms <milliseconds> on the CLI.`
      : `timeout_ms is already at the maximum supported ${String(MAX_EVM_TIMEOUT_MS)} ms; no higher worker deadline is supported. Report this blocker or select another suitable complete carrier with caller approval.`
  } This is a per-call setting; no server restart is needed. It covers the owned EVMole worker command, not carrier acquisition or final reply reads. Allow the MCP client deadline to cover acquisition, the worker, reply reads, cleanup and delivery; increasing only that client deadline does not change this budget. Separate producer_limits control carrier/reply/diagnostic bytes, address-space/file bytes and CPU seconds; timeout_ms does not raise them. The 256 MiB worker heap stays independent. Resolve any incomplete cleanup before retrying; do not repeat the unchanged failed call.`;

/** Correlate a reserved exit with the owned worker's actual failure branch. */
export interface EvmFileSizeFailureEvidence {
  readonly verified: boolean;
  readonly failure: string | null;
}

/** Keep carrier read, engine and owned lifecycle failures distinct. */
export interface EvmFailureContext {
  readonly phase: "configuration" | "artifact-read" | "worker";
  readonly path: string;
  readonly workerLimits?: EvmWorkerLimits | undefined;
  readonly limiter?: string | undefined;
  readonly fileFailure?: EvmFileSizeFailureEvidence | undefined;
  readonly timeoutMs?: number | undefined;
  readonly producerLimits?: EvmProducerLimits | undefined;
}

export const evmInterfaceFailure = (
  cause: unknown,
  {
    phase,
    path,
    workerLimits,
    limiter = "/usr/bin/prlimit",
    fileFailure,
    timeoutMs = DEFAULT_EVM_TIMEOUT_MS,
    producerLimits = selectedEvmProducerLimits(undefined),
  }: EvmFailureContext,
): AnalysisError => {
  const cleanup =
    cause instanceof ArtifactReaderFailure ? cause.cleanup : undefined;
  const cleanupOptions = cleanup === undefined ? {} : { cleanup };
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
          },
        },
        { operation: "inspect_evm_interface", cause },
      );
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError("inspect_evm_interface", {
        cause: cause.cancellation?.reason,
        ...outputOptions,
        ...cleanupOptions,
      });
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError("inspect_evm_interface", timeoutMs, {
        ...outputOptions,
        ...cleanupOptions,
        userMessage: `The EVMole worker reached its ${String(timeoutMs)} ms server/provider deadline (timeout_ms). This is not a carrier-read or MCP client deadline. Omitted timeout_ms uses ${String(DEFAULT_EVM_TIMEOUT_MS)} ms.`,
        remediationAction: evmTimeoutRecovery(timeoutMs),
      });
    if (cause.reason === "output-limit")
      return new AnalysisOutputError("inspect_evm_interface", cause.message, {
        ...outputOptions,
        userMessage: `EVMole worker diagnostics exceeded producer_limits.diagnostic_bytes (${String(producerLimits.diagnostic_bytes)} bytes).`,
        diagnostics: {
          parameter: "producer_limits.diagnostic_bytes",
          effective_value: producerLimits.diagnostic_bytes,
        },
        remediationAction: evmProducerLimitRecovery(
          producerLimits,
          "diagnostic_bytes",
        ),
      });
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
        {
          ...outputOptions,
          retryable: false,
          remediationAction:
            cause.snapshot.signal === "SIGXCPU"
              ? evmProducerLimitRecovery(producerLimits, "cpu_seconds")
              : evmProducerLimitRecovery(producerLimits, "file_bytes"),
        },
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
      return new AnalysisCancelledError("inspect_evm_interface", {
        cause: artifactFileCancellationCause(cause),
        ...cleanupOptions,
      });
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(
        "inspect_evm_interface",
        path,
        cause.message,
        { cause, ...cleanupOptions },
      );
    if (
      phase === "artifact-read" &&
      cause.reason === "limit" &&
      cause.boundary === "file-size"
    )
      return new AnalysisResourceConstraintError(
        "inspect_evm_interface",
        "file-size",
        `${cause.message} producer_limits.input_bytes is ${String(producerLimits.input_bytes)} bytes; timeout_ms does not raise it.`,
        {
          maximum_input_bytes: producerLimits.input_bytes,
          parameter: "producer_limits.input_bytes",
        },
        {
          cause,
          ...cleanupOptions,
          retryable: false,
          remediationAction: evmProducerLimitRecovery(
            producerLimits,
            "input_bytes",
          ),
        },
      );
    if (phase === "artifact-read" && ["path", "format"].includes(cause.reason))
      return new AnalysisInputError(
        "inspect_evm_interface",
        {
          ...selectedPathRefusal(cause),
          ...cleanupOptions,
        },
        [
          {
            path: ["path"],
            reason: "invalid_format",
            message: cause.message,
          },
        ],
      );
  }
  if (phase === "artifact-read" && cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(
        "inspect_evm_interface",
        path,
        cause.code,
        { cause, ...cleanupOptions },
      );
    const pathErrno = artifactSelectedPathErrno(cause);
    if (pathErrno !== undefined)
      return new AnalysisInputError(
        "inspect_evm_interface",
        { cause, ...cleanupOptions },
        [
          {
            path: ["path"],
            reason: "invalid_value",
            message: `Selected bytecode carrier could not be read (${pathErrno}): ${path}.`,
          },
        ],
      );
  }
  return new ProviderAdapterError(
    EVMOLE_PROVIDER_IDENTITY.id,
    "inspect_evm_interface",
    {
      cause,
      ...cleanupOptions,
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? { capturedOutput: capturedEvmOutput(cause.snapshot) }
        : {}),
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
