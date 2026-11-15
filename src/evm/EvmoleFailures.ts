import {
  deadlineParameterLimit,
  MAX_NODE_TIMER_DELAY_MS,
} from "../domain/analysisResourceLimits.js";
import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import type { EvmWorkerLimits } from "./EvmWorkerLimits.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { ProviderOutcomeContext } from "../process/classifyProviderOutcome.js";
import type { ProviderFailureDialect } from "../providers/classifyProviderFailure.js";
import {
  DEFAULT_EVM_TIMEOUT_MS,
  selectedEvmProducerLimits,
  evmProducerLimitRecovery,
  type EvmProducerLimits,
} from "../domain/evm/evmInterface.js";
import {
  EVM_FILE_SIZE_FAILURE_EXIT,
  EVM_WORKER_HEAP_MIB,
} from "./EvmoleRelease.js";
import { EVMOLE_PROVIDER_IDENTITY } from "./EvmoleProviderIdentity.js";
import { errorMessage } from "../kernel/errorMessage.js";

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
    timeoutMs < MAX_NODE_TIMER_DELAY_MS
      ? `Increase timeout_ms above ${String(timeoutMs)} (integer milliseconds, maximum ${String(MAX_NODE_TIMER_DELAY_MS)}).`
      : `timeout_ms is already at the maximum supported ${String(MAX_NODE_TIMER_DELAY_MS)} ms; no higher worker deadline is supported. Report this blocker or select another suitable complete carrier with caller approval.`
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

/** EVMole's failure dialect for one phase of `inspect_evm_interface`. */
export const evmFailureDialect = (
  context: EvmFailureContext,
): ProviderFailureDialect => {
  const resolved: ResolvedEvmFailureContext = {
    ...context,
    limiter: context.limiter ?? "/usr/bin/prlimit",
    timeoutMs: context.timeoutMs ?? DEFAULT_EVM_TIMEOUT_MS,
    producerLimits:
      context.producerLimits ?? selectedEvmProducerLimits(undefined),
  };
  const { phase, path, producerLimits } = resolved;
  return {
    providerId: EVMOLE_PROVIDER_IDENTITY.id,
    operation: OPERATION,
    command: () => evmCommandContext(resolved),
    ...(phase === "artifact-read"
      ? {
          file: {
            path,
            description: "bytecode carrier",
            retainCompletedIdentity: true,
            fileSize: (limit, details) =>
              new AnalysisResourceConstraintError(
                OPERATION,
                "file-size",
                `${limit.message} producer_limits.input_bytes is ${String(producerLimits.input_bytes)} bytes; timeout_ms does not raise it.`,
                {
                  maximum_input_bytes: producerLimits.input_bytes,
                  parameter: "producer_limits.input_bytes",
                },
                {
                  ...details,
                  retryable: false,
                  remediationAction: evmProducerLimitRecovery(
                    producerLimits,
                    "input_bytes",
                  ),
                },
              ),
          },
        }
      : {}),
    unclassified: (unrecognised, details) =>
      new ProviderAdapterError(EVMOLE_PROVIDER_IDENTITY.id, OPERATION, {
        ...details,
        cause: unrecognised,
        diagnostics: {
          ...evmWorkerDiagnostics(context),
          reason: errorMessage(unrecognised),
        },
      }),
  };
};

/** The EVMole worker's dialect: its prlimit launcher and its reserved EFBIG exit. */
const evmCommandContext = (
  context: ResolvedEvmFailureContext,
): ProviderOutcomeContext => {
  const { workerLimits, limiter, fileFailure, timeoutMs, producerLimits } =
    context;
  return {
    operation: OPERATION,
    capturedOutput: capturedProviderOutput,
    timeout: {
      ms: timeoutMs,
      userMessage: `The EVMole worker reached its ${String(timeoutMs)} ms server/provider deadline (timeout_ms). This is not a carrier-read or MCP client deadline. Omitted timeout_ms uses ${String(DEFAULT_EVM_TIMEOUT_MS)} ms.`,
      remediationAction: evmTimeoutRecovery(timeoutMs),
      limit: deadlineParameterLimit(
        "timeout_ms",
        timeoutMs,
        DEFAULT_EVM_TIMEOUT_MS,
      ),
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
  };
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
