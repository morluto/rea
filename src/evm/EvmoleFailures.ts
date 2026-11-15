import type { EvmWorkerLimits } from "./EvmWorkerLimits.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { stableArtifactInputRecovery } from "../artifacts/StableArtifactFailure.js";
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
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import {
  providerOutcomeOf,
  type ProviderOutcome,
} from "../process/ProviderOutcome.js";
import { classifyProviderOutcome } from "../process/classifyProviderOutcome.js";
import {
  DEFAULT_EVM_TIMEOUT_MS,
  MAX_EVM_TIMEOUT_MS,
  selectedEvmProducerLimits,
  evmProducerLimitRecovery,
  type EvmProducerLimits,
} from "../domain/evm/evmInterface.js";
import {
  EVM_FILE_SIZE_FAILURE_EXIT,
  EVM_WORKER_HEAP_MIB,
} from "./EvmoleRelease.js";
import { EVMOLE_PROVIDER_IDENTITY } from "./EvmoleProviderIdentity.js";

const OPERATION = "inspect_evm_interface";

/** Both a structured worker refusal and reply-file admission name this allowance. */
export const evmReplyBudgetFailure = (
  reason: string,
  options: AnalysisErrorOptions,
  limits: EvmProducerLimits = selectedEvmProducerLimits(undefined),
) =>
  new AnalysisResourceConstraintError(
    OPERATION,
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
interface EvmFailureContext {
  readonly phase: "configuration" | "artifact-read" | "worker";
  readonly path: string;
  readonly workerLimits?: EvmWorkerLimits | undefined;
  readonly limiter?: string | undefined;
  readonly fileFailure?: EvmFileSizeFailureEvidence | undefined;
  readonly timeoutMs?: number | undefined;
  readonly producerLimits?: EvmProducerLimits | undefined;
}

type ResolvedEvmFailureContext = Omit<
  EvmFailureContext,
  "limiter" | "timeoutMs" | "producerLimits"
> & {
  readonly limiter: string;
  readonly timeoutMs: number;
  readonly producerLimits: EvmProducerLimits;
};

export const evmInterfaceFailure = (
  cause: unknown,
  context: EvmFailureContext,
): AnalysisError => {
  const resolved: ResolvedEvmFailureContext = {
    ...context,
    limiter: context.limiter ?? "/usr/bin/prlimit",
    timeoutMs: context.timeoutMs ?? DEFAULT_EVM_TIMEOUT_MS,
    producerLimits:
      context.producerLimits ?? selectedEvmProducerLimits(undefined),
  };
  const { phase, path, producerLimits } = resolved;
  const cleanup =
    cause instanceof ArtifactReaderFailure ? cause.cleanup : undefined;
  const cleanupOptions = cleanup === undefined ? {} : { cleanup };
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof OwnedCommandFailure && cause.cleanupFailure !== null)
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
      { operation: OPERATION, cause },
    );
  const outcome = providerOutcomeOf(cause);
  if (outcome !== undefined) return evmCommandFailure(outcome, resolved);
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(OPERATION, {
        cause: artifactFileCancellationCause(cause),
        ...cleanupOptions,
      });
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
        cause,
        ...cleanupOptions,
      });
    if (
      phase === "artifact-read" &&
      cause.reason === "limit" &&
      cause.boundary === "file-size"
    )
      return new AnalysisResourceConstraintError(
        OPERATION,
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
        OPERATION,
        {
          cause,
          ...cleanupOptions,
          ...stableArtifactInputRecovery(cause),
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
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
        ...cleanupOptions,
      });
    const pathErrno = artifactSelectedPathErrno(cause);
    if (pathErrno !== undefined)
      return new AnalysisInputError(OPERATION, { cause, ...cleanupOptions }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected bytecode carrier could not be read (${pathErrno}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(EVMOLE_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    ...cleanupOptions,
    diagnostics: {
      ...evmWorkerDiagnostics(context),
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

/** The EVMole worker's dialect: its prlimit launcher and its reserved EFBIG exit. */
const evmCommandFailure = (
  outcome: ProviderOutcome,
  context: ResolvedEvmFailureContext,
): AnalysisError => {
  const { workerLimits, limiter, fileFailure, timeoutMs, producerLimits } =
    context;
  return classifyProviderOutcome(outcome, {
    operation: OPERATION,
    capturedOutput: capturedEvmOutput,
    timeout: {
      ms: timeoutMs,
      userMessage: `The EVMole worker reached its ${String(timeoutMs)} ms server/provider deadline (timeout_ms). This is not a carrier-read or MCP client deadline. Omitted timeout_ms uses ${String(DEFAULT_EVM_TIMEOUT_MS)} ms.`,
      remediationAction: evmTimeoutRecovery(timeoutMs),
    },
    outputLimit: {
      limits: {
        maximum_diagnostic_bytes: producerLimits.diagnostic_bytes,
        parameter: "producer_limits.diagnostic_bytes",
      },
      recovery: {
        retryable: false,
        remediationAction: evmProducerLimitRecovery(
          producerLimits,
          "diagnostic_bytes",
        ),
      },
    },
    resourceSignal: (signal) => ({
      limits: configuredWorkerLimits(workerLimits),
      recovery: {
        retryable: false,
        remediationAction: evmProducerLimitRecovery(
          producerLimits,
          signal === "SIGXCPU" ? "cpu_seconds" : "file_bytes",
        ),
      },
    }),
    runtimeExhaustion: () => ({
      limits: { worker_heap_mib: EVM_WORKER_HEAP_MIB },
      recovery: {
        retryable: false,
        remediationAction: `The EVMole worker's ${String(EVM_WORKER_HEAP_MIB)} MiB heap is fixed in this release; producer_limits and timeout_ms do not raise it. Select a smaller bytecode carrier; repeating the unchanged request is expected to fail the same way.`,
      },
    }),
    dialect: (outcome, details) => {
      if (outcome.kind === "launch-refused") {
        const reason = `Configured util-linux prlimit could not launch (${outcome.refusal.code}): ${limiter}. Check its executable/interpreter and host execute access.`;
        return new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          reason,
          { ...details, userMessage: reason },
        );
      }
      // The reserved exit means EFBIG only when the worker's marker says so.
      if (
        outcome.kind === "exited" &&
        fileFailure?.verified === true &&
        outcome.exitCode === EVM_FILE_SIZE_FAILURE_EXIT &&
        outcome.signal === null
      )
        return new AnalysisResourceConstraintError(
          OPERATION,
          "file-size",
          "Owned EVM worker reported EFBIG while writing its reply; the exact write failure cause is unknown. Effective worker limits are unknown. Configured soft limits are retained separately.",
          configuredWorkerLimits(workerLimits),
          {
            ...details,
            retryable: false,
            remediationAction: evmProducerLimitRecovery(
              producerLimits,
              "file_bytes",
            ),
          },
        );
      return new ProviderAdapterError(EVMOLE_PROVIDER_IDENTITY.id, OPERATION, {
        ...details,
        diagnostics: {
          ...evmWorkerDiagnostics(context),
          reason: outcome.message,
          failure_kind: outcome.kind,
          // A stream failure is not an ordinary exit, but its recorded
          // status remains evidence.
          ...(outcome.output === undefined
            ? {}
            : {
                exit_code: outcome.output.snapshot.exitCode ?? null,
                signal: outcome.output.snapshot.signal ?? null,
              }),
        },
      });
    },
  });
};

const evmWorkerDiagnostics = ({
  phase,
  path,
  workerLimits,
  fileFailure,
}: EvmFailureContext) => ({
  phase,
  path,
  ...(workerLimits === undefined
    ? {}
    : { configured_resource_limits: { ...workerLimits } }),
  ...(fileFailure === undefined
    ? {}
    : { file_size_failure_marker: { ...fileFailure } }),
});

/** Configured soft limits; the effective limits the worker ran under are unknown. */
const configuredWorkerLimits = (workerLimits: EvmWorkerLimits | undefined) =>
  workerLimits === undefined
    ? null
    : {
        configured_soft_limits: {
          address_space_bytes: workerLimits.addressSpaceBytes,
          cpu_seconds: workerLimits.cpuSeconds,
          file_size_bytes: workerLimits.fileSizeBytes,
        },
        effective_soft_limits: null,
      };

/** Preserve retained worker diagnostics with their observed truncation status. */
export const capturedEvmOutput = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  truncated: snapshot.diagnosticTruncated === true,
});
