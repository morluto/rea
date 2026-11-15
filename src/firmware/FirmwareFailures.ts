import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import {
  type AnalysisCleanupLease,
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
} from "../resources/index.js";
import type {
  AnalysisCapturedOutput,
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  cancelledBy,
  isAborted,
  type AbortedSignal,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { ProviderFailureDialect } from "../providers/classifyProviderFailure.js";
import type { FirmwareDeadline } from "./FirmwareDeadline.js";
import { firmwareDeadlineElapsed } from "./FirmwareDeadline.js";
import { z } from "zod";
import { FIRMWARE_LIMITS } from "./FirmwareRelease.js";

/** Fixed firmware allowance. analysis_timeout_ms does not raise it. */
export const firmwareLimitRecovery = (allowance: string): string =>
  `${allowance}. This release has no runtime override. analysis_timeout_ms (--analysis-timeout-ms in the CLI) does not raise it. Repeating the unchanged request fails the same way.`;

/** Classify a prlimit signal that is not the analysis wall clock. */
export const firmwareSignalLimitError = (
  operation: string,
  signal: NodeJS.Signals | null | undefined,
  fileSizeBytes: number,
  fileSizeAdjustable: boolean,
  capturedOutput?: AnalysisCapturedOutput,
): AnalysisResourceConstraintError | undefined => {
  const recovery = (
    remediationAction: string,
  ): AnalysisResourceConstraintError =>
    new AnalysisResourceConstraintError(
      operation,
      signal === "SIGXCPU" ? "cpu" : "file-size",
      signal === "SIGXCPU"
        ? `Firmware analysis reached its ${String(FIRMWARE_LIMITS.cpuSeconds)}-second CPU allowance (cpuSeconds).`
        : `Firmware analysis reached its ${String(fileSizeBytes)}-byte file-size allowance.`,
      signal === "SIGXCPU"
        ? { cpu_seconds: FIRMWARE_LIMITS.cpuSeconds }
        : { file_size_bytes: fileSizeBytes },
      {
        retryable: false,
        remediationAction,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      },
    );
  if (signal === "SIGXCPU")
    return recovery(
      firmwareLimitRecovery(
        `cpuSeconds is ${String(FIRMWARE_LIMITS.cpuSeconds)}`,
      ),
    );
  if (signal !== "SIGXFSZ") return undefined;
  return recovery(
    fileSizeAdjustable
      ? `The file-size cap for this extraction is ${String(fileSizeBytes)} bytes, one byte above max_output_bytes. analysis_timeout_ms does not raise it. Increase max_output_bytes when it is below its schema maximum and the larger staging budget is still required. Repeating the unchanged request fails the same way.`
      : firmwareLimitRecovery(
          `The firmware file-size allowance is ${String(fileSizeBytes)} bytes`,
        ),
  );
};

/** Address-space and CPU ceilings that a wall-clock change cannot raise. */
export const firmwareProcessLimitRecovery = (
  fileSizeBytes: number,
  fileSizeAdjustable: boolean,
): string =>
  `cpuSeconds is ${String(FIRMWARE_LIMITS.cpuSeconds)}. The address-space allowance is ${String(FIRMWARE_LIMITS.addressSpaceBytes)} bytes. This release has no runtime override for those per-process allowances, and analysis_timeout_ms does not raise them. ${
    fileSizeAdjustable
      ? `The file-size cap for this call is ${String(fileSizeBytes)} bytes, one byte above max_output_bytes. analysis_timeout_ms does not raise it.`
      : `The file-size allowance is ${String(fileSizeBytes)} bytes. This release has no runtime override for that allowance, and analysis_timeout_ms does not raise it.`
  }`;

type FirmwarePublicationProgress = {
  readonly output_directory: string;
  readonly verified_files: number;
  readonly total_files: number;
};

/** The signal one firmware phase passed to its work, and the deadline that phase armed. */
export interface FirmwarePhase {
  readonly signal: AbortSignal;
  readonly deadline: FirmwareDeadline;
  readonly publication?: FirmwarePublicationProgress | undefined;
}

interface FirmwareFailureContext {
  readonly engine: string;
  readonly operation: string;
  /** The phase whose signal the failed work observed; absent outside a phase. */
  readonly phase?: FirmwarePhase | undefined;
  readonly treeCleanupLease?: AnalysisCleanupLease | undefined;
}

const timeoutFailure = (
  operation: string,
  reason: unknown,
  deadline: FirmwareDeadline,
  publication: FirmwarePublicationProgress | undefined,
  details: Omit<AnalysisErrorOptions, "cause"> = {},
): AnalysisTimeoutError =>
  new AnalysisTimeoutError(operation, deadline.timeoutMs, {
    ...details,
    cause: reason,
    diagnostics: {
      phase: deadline.phase,
      ...(publication === undefined ? {} : { publication }),
    },
    ...(deadline.phase === "publication"
      ? {
          userMessage: `Firmware publication exceeded its ${deadline.timeoutMs}ms budget. Extraction already completed.`,
          remediationAction:
            "Read any retained publication receipt first. For a retry, choose an absent local output directory or increase publication_timeout_ms (--publication-timeout-ms in the CLI).",
        }
      : {
          userMessage: `Firmware analysis exceeded its ${deadline.timeoutMs}ms wall-clock budget${operation === "extract_firmware" ? " before publication" : " during inspection or its final workspace cleanup"}.`,
          remediationAction: `Retry the same operation and preserve the selected input and analysis question. ${deadline.timeoutMs < MAX_NODE_TIMER_DELAY_MS ? `Increase analysis_timeout_ms (--analysis-timeout-ms in the CLI), an integer from 1 to ${MAX_NODE_TIMER_DELAY_MS} (default 120000).` : `analysis_timeout_ms (--analysis-timeout-ms in the CLI) is already at the maximum ${MAX_NODE_TIMER_DELAY_MS}; do not increase it further.`} Set the client tool-call timeout above the analysis budget plus publication and cleanup headroom. publication_timeout_ms only controls the later publication phase and cannot repair this analysis timeout. Fixed per-process CPU, memory and byte limits are unchanged. If cleanup is incomplete, resolve the reported owned resources before retrying; no server restart is needed after confirmed cleanup.`,
        }),
  });

/**
 * The phase deadline's timeout when that deadline, not the caller, aborted the
 * phase signal. The deadline owns its own expiry; no cancellation is reread.
 */
const deadlineTimeout = (
  operation: string,
  phase: FirmwarePhase,
  details?: Omit<AnalysisErrorOptions, "cause">,
): AnalysisTimeoutError | undefined =>
  phase.signal.aborted &&
  phase.deadline.signal.aborted &&
  phase.signal.reason === phase.deadline.signal.reason
    ? timeoutFailure(
        operation,
        phase.signal.reason,
        phase.deadline,
        phase.publication,
        details,
      )
    : undefined;

/** What an aborted phase signal reports: its deadline's timeout, else the caller's cancellation. */
export const firmwareSignalInterruption = (
  operation: string,
  signal: AbortedSignal,
  deadline?: FirmwareDeadline,
  publication?: FirmwarePublicationProgress,
): AnalysisError =>
  (deadline === undefined
    ? undefined
    : deadlineTimeout(operation, { signal, deadline, publication })) ??
  cancelledBy(operation, signal);

/** Preserve observed cancellation identity; otherwise enforce the monotonic budget. */
export const firmwarePhaseInterruption = (
  operation: string,
  signal: AbortSignal,
  deadline: FirmwareDeadline,
  publication?: FirmwarePublicationProgress,
): AnalysisError | undefined =>
  isAborted(signal)
    ? firmwareSignalInterruption(operation, signal, deadline, publication)
    : firmwareDeadlineElapsed(deadline)
      ? timeoutFailure(operation, undefined, deadline, publication)
      : undefined;

/**
 * Firmware's dialect for the shared provider failure classifier. A read the
 * phase's deadline cancelled reports that deadline's timeout; a read whose own
 * cleanup failed reports the firmware cleanup error, bound to the extraction
 * tree when the read has no descriptor lease, beside the read's primary.
 */
export const firmwareFailureDialect = (
  context: FirmwareFailureContext,
): ProviderFailureDialect => {
  const { engine, operation, phase, treeCleanupLease } = context;
  return {
    providerId: engine,
    operation,
    recognise: (cause, details) =>
      cause instanceof z.ZodError
        ? new AnalysisOutputError(
            operation,
            "Tool report violated the pinned producer protocol",
            { ...details, cause },
          )
        : undefined,
    ...(phase === undefined
      ? {}
      : {
          interruption: (details) => deadlineTimeout(operation, phase, details),
        }),
    readCleanup: (read, primary) => {
      const cleanup = new ProviderCleanupError(
        engine,
        read.cleanup.resources,
        { reason: read.cleanup.reason },
        { operation, cause: read },
      );
      bindArtifactFileCleanup(read, cleanup);
      if (read.cleanupLeases === undefined)
        treeCleanupLease?.bindCleanupError(cleanup);
      if (primary === undefined) return cleanup;
      // A file operation's own outcome shares its cleanup; a cancelled read's does not.
      return analysisErrorWithCleanupFailure(
        primary,
        cleanup,
        operation,
      ).bindCleanupDependencies(
        read instanceof ArtifactFileCleanupFailure
          ? [primary, cleanup]
          : [cleanup],
      );
    },
    unclassified: (cause, details) =>
      new ProviderAdapterError(engine, operation, {
        ...details,
        cause,
        diagnostics: {
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      }),
  };
};
