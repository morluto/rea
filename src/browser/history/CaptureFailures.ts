import { join } from "node:path";
import { capturedProviderOutput } from "../../process/capturedProviderOutput.js";
import { javaScriptWorkerMemoryLimitBytes } from "../../process/JavaScriptWorkerMemoryLimit.js";
import { isAbortOf } from "../../process/SignalAbort.js";
import { captureBudgets } from "./CaptureBudgets.js";
import { analysisSettingLimit } from "../../domain/analysisSettingDefinitions.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import {
  AnalysisCleanupLeaseGroup,
  type AnalysisCleanupLease,
  type ArtifactResourceScope,
  ArtifactFileCleanupFailure,
  ArtifactReaderFailure,
  stableArtifactInputRecovery,
  readerIntegrityFailure,
  bindArtifactFileCleanup,
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  artifactSelectedPathErrno,
  readStableArtifact,
} from "../../resources/index.js";
import {
  analysisErrorWithCleanupFailure,
  analysisErrorWithCleanupDependencies,
} from "../../domain/analysisErrorCleanup.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "../../domain/analysisErrorBase.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
  fixedCeilingConstraint,
  type ResourceConstraintRecovery,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import {
  selectedWebNetworkCaptureTimeoutMs,
  webNetworkCaptureBudgetFacts,
  webNetworkCaptureBudgetRecovery,
  webNetworkCaptureTimeoutRecovery,
  type InspectWebNetworkCaptureInput,
} from "../../domain/webNetworkCapture.js";
import {
  captureDecoderHeapContinuingRecovery,
  captureDecoderHeapRecovery,
  DEFAULT_CAPTURE_DECODER_HEAP,
  type CaptureDecoderHeap,
} from "../../config/captureDecoderHeap.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import { providerOutcomeOf } from "../../process/ProviderOutcome.js";
import {
  runtimeExhaustionReport,
  type RuntimeExhaustion,
} from "../../process/RuntimeExhaustion.js";
import { NODE_CAPTURE_HEAP_ENFORCED } from "./CaptureRelease.js";
import { CAPTURE_DECODER_SEMI_SPACE_MIB } from "../../domain/analysisResourceLimits.js";
import {
  CAPTURE_FORMAT,
  CAPTURE_LIMITS,
  type CaptureFormatError,
} from "./CaptureFormatError.js";
import { errorMessage } from "../../kernel/errorMessage.js";
const OPERATION = "inspect_web_network_capture";

/** A refused protobuf body decode; a limit names the budget that owns it. */
export const protobufCaptureFailure = (
  input: InspectWebNetworkCaptureInput,
  cause: CaptureFormatError,
): AnalysisError => {
  const { limit } = cause;
  if (limit === undefined || !isParseLimit(cause, CAPTURE_FORMAT))
    return new AnalysisInputError(OPERATION, { cause }, [
      {
        path: ["protobuf"],
        reason: "invalid_format",
        message: cause.message,
      },
    ]);
  const { parameter, expected } = CAPTURE_LIMITS[limit.name];
  return parseLimitConstraint(OPERATION, "capacity", cause, {
    legacyMaximumKey: expected,
    retryable: false,
    ...(parameter === null
      ? {}
      : {
          remediationAction: webNetworkCaptureBudgetRecovery(
            input,
            parameter,
            limit.maximum,
          ),
        }),
  });
};

/** Reason for a decoder whose owned process tree reached its Job Object commit limit. */
export const CAPTURE_PROCESS_MEMORY_LIMIT_REASON =
  "The capture decoder reached its Windows Job Object memory limit";

/** Sibling of reply.json. The parent reads it after SIGXCPU. */
export const EFFECTIVE_DECODER_CPU_RECORD = "effective-cpu.json";

const MAX_EFFECTIVE_CPU_RECORD_BYTES = 64;

/** Installed CPU ceiling and the decoder budget that was requested. */
export interface RecordedDecoderCpuCeiling {
  readonly seconds: number;
  /** The budget passed to the clamp. The installed ceiling never exceeds it. */
  readonly requestedSeconds: number;
}

const recordedCpuSeconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/**
 * Read the installed CPU ceiling and the requested decoder budget.
 * Undefined when the record is absent, malformed, or claims a ceiling above
 * the budget it names.
 */
export const parseRecordedCpuCeiling = (
  bytes: Buffer,
): RecordedDecoderCpuCeiling | undefined => {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_EFFECTIVE_CPU_RECORD_BYTES
  )
    return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined;
  const record = parsed as Record<string, unknown>;
  const seconds = recordedCpuSeconds(record.seconds);
  const requestedSeconds = recordedCpuSeconds(record.requested_seconds);
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes("seconds") ||
    !keys.includes("requested_seconds") ||
    seconds === undefined ||
    requestedSeconds === undefined ||
    seconds > requestedSeconds
  )
    return undefined;
  return { seconds, requestedSeconds };
};

/** The CPU ceiling the decoder published before it was killed. */
export const recordedDecoderCpuSeconds = async (
  runtimePath: string | undefined,
  cause: unknown,
  resources?: ArtifactResourceScope,
): Promise<RecordedDecoderCpuCeiling | undefined> => {
  if (
    runtimePath === undefined ||
    !(cause instanceof OwnedCommandFailure) ||
    cause.snapshot?.signal !== "SIGXCPU"
  )
    return undefined;
  // Absence and a bad record stay unknown. A failed close stays on
  // `resources` and must not escape this helper: the decoder classifies
  // SIGXCPU before it releases the runtime.
  try {
    const snapshot = await readStableArtifact(
      join(runtimePath, EFFECTIVE_DECODER_CPU_RECORD),
      MAX_EFFECTIVE_CPU_RECORD_BYTES,
      undefined,
      undefined,
      resources,
    );
    return parseRecordedCpuCeiling(snapshot.bytes);
  } catch (cause: unknown) {
    const outcome =
      cause instanceof ArtifactFileCleanupFailure
        ? cause.fileCleanupFailure.outcome
        : undefined;
    if (outcome?.kind !== "completed") return undefined;
    const value: unknown = outcome.value;
    if (
      typeof value !== "object" ||
      value === null ||
      !("bytes" in value) ||
      !Buffer.isBuffer(value.bytes)
    )
      return undefined;
    return parseRecordedCpuCeiling(value.bytes);
  }
};

/**
 * The file's one resource-constraint construction. A fixed work allowance
 * says additional CPU time does not raise it, which is the wrong recovery
 * for an inherited RLIMIT_CPU the caller can raise.
 */
const historicalCaptureResourceConstraint = (
  resource: "cpu" | "memory",
  reason: string,
  reportedLimits: NonNullable<
    ConstructorParameters<typeof AnalysisResourceConstraintError>[3]
  >,
  options: AnalysisErrorOptions & ResourceConstraintRecovery,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    OPERATION,
    resource,
    reason,
    reportedLimits,
    options,
  );

/** A SIGXCPU death names the control that stopped the decoder. */
const captureCpuSignalFailure = (
  input: InspectWebNetworkCaptureInput,
  cause: OwnedCommandFailure,
  ceiling: RecordedDecoderCpuCeiling | undefined,
): AnalysisResourceConstraintError => {
  const captured =
    cause.snapshot === null
      ? {}
      : { capturedOutput: capturedProviderOutput(cause.snapshot) };
  const suffix = `${input.capture_path}. No complete capture result is available.`;
  // The clamp never installs more than the requested budget. Equality means
  // that budget stopped the decode, so raising RLIMIT_CPU cannot extend it.
  if (ceiling !== undefined && ceiling.seconds === ceiling.requestedSeconds) {
    const budget = String(ceiling.requestedSeconds);
    return fixedCeilingConstraint(
      OPERATION,
      "cpu",
      `The decoder CPU budget of ${budget} seconds stopped the decoder. Raising RLIMIT_CPU does not raise that budget: ${suffix}`,
      {
        name: "The mitmproxy decoder CPU budget",
        kind: "work",
        limit: ceiling.requestedSeconds,
        unit: "seconds",
        narrowing: "Select a smaller capture.",
      },
      { cause, ...captured },
    );
  }
  const observed = {
    boundary: "historical-capture-decoder",
    capture_path: input.capture_path,
    format: input.format,
    observed_signal: "SIGXCPU",
    observed_exit_code: cause.snapshot?.exitCode ?? null,
  };
  if (ceiling !== undefined && ceiling.seconds < ceiling.requestedSeconds) {
    const installed = String(ceiling.seconds);
    const budget = String(ceiling.requestedSeconds);
    return historicalCaptureResourceConstraint(
      "cpu",
      `The effective RLIMIT_CPU of ${installed} seconds stopped the decoder. The decoder budget of ${budget} seconds does not raise an inherited limit: ${suffix}`,
      {
        ...observed,
        cpu_seconds: ceiling.seconds,
        requested_cpu_seconds: ceiling.requestedSeconds,
      },
      {
        cause,
        retryable: false,
        remediationAction: `Raise the process RLIMIT_CPU above ${installed} seconds, or select a smaller capture. The decoder budget stays ${budget} seconds.`,
        ...captured,
      },
    );
  }
  return historicalCaptureResourceConstraint(
    "cpu",
    `The decoder terminated with SIGXCPU. The effective CPU limit was not recorded: ${suffix}`,
    observed,
    {
      cause,
      retryable: false,
      remediationAction:
        "The installed CPU ceiling was not recorded. This result does not say whether an inherited RLIMIT_CPU or the decoder budget stopped the work. Select a smaller capture, or raise a tighter inherited RLIMIT_CPU and repeat.",
      ...captured,
    },
  );
};

/**
 * Preserve the origin and typed cause of a historical capture failure.
 * `cleanupLease` is the decoder's lease on `rawCause`'s retained process
 * owner; its confirmed release resolves the cleanup this failure reports.
 */
export const historicalCaptureFailure = (
  input: InspectWebNetworkCaptureInput,
  rawCause: unknown,
  phase: "capture-read" | "descriptor-read" | "decoder",
  options?: ExecutionOptions,
  heap: CaptureDecoderHeap = DEFAULT_CAPTURE_DECODER_HEAP,
  cleanupLease?: AnalysisCleanupLease,
  cpuCeiling?: RecordedDecoderCpuCeiling,
): AnalysisError => {
  const { cause, origin } = artifactFilePrimaryFacts(rawCause);
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  const descriptorRead = phase === "descriptor-read";
  const sourcePath = descriptorRead
    ? (input.protobuf?.schema?.descriptor_set_path ?? input.capture_path)
    : input.capture_path;
  const inputPath = descriptorRead
    ? ["protobuf", "schema", "descriptor_set_path"]
    : ["capture_path"];
  const sourceLabel = descriptorRead ? "descriptor set" : "capture";
  if (
    origin === "owned-or-classified" &&
    cause instanceof OwnedCommandFailure
  ) {
    if (cause.cleanupFailure !== null) {
      const cleanup = new ProviderCleanupError(
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
      if (cleanupLease !== undefined)
        new AnalysisCleanupLeaseGroup(cleanup, [cleanupLease]);
      return cause.cause instanceof OwnedCommandFailure
        ? analysisErrorWithCleanupFailure(
            historicalCaptureFailure(
              input,
              cause.cause,
              phase,
              options,
              heap,
              undefined,
              cpuCeiling,
            ),
            cleanup,
            OPERATION,
          )
        : cleanup;
    }
    if (cause.reason === "cancelled")
      return cancelledBy(
        OPERATION,
        carriedReason(
          cause.cancellation === undefined
            ? options?.signal?.aborted === true
              ? options.signal.reason
              : undefined
            : cause.cancellation.reason,
        ),
      );
    if (cause.reason === "timeout") {
      const timeoutMs = selectedWebNetworkCaptureTimeoutMs(
        input.capture_timeout_ms,
      );
      return new AnalysisTimeoutError(
        OPERATION,
        timeoutMs,
        webNetworkCaptureTimeoutRecovery(timeoutMs),
      );
    }
    // The supervisor observed V8's heap report as output streamed, so a
    // retention budget or a stack trace that overflowed it cannot hide it.
    const outcome = providerOutcomeOf(cause);
    if (phase === "decoder" && outcome.kind === "runtime-exhausted")
      return captureMemoryFailure(
        input,
        `The ${input.format} decoder exhausted its ${String(heap.oldGenerationMiB)} MiB V8 old-generation heap (source ${heap.source})`,
        cause,
        heap,
        outcome.exhaustion,
      );
    if (cause.reason === "output-limit")
      return new AnalysisOutputError(OPERATION, cause.message);
    // The job's own notification is runtime-independent; Bun's exit status
    // and diagnostics for an allocation failure are not.
    if (
      phase === "decoder" &&
      cause.reason === "process" &&
      cause.snapshot?.memoryLimitReached === true
    )
      return captureMemoryFailure(
        input,
        CAPTURE_PROCESS_MEMORY_LIMIT_REASON,
        cause,
        heap,
      );
    if (
      phase === "decoder" &&
      outcome.kind === "resource-signal" &&
      outcome.signal === "SIGXCPU"
    )
      return captureCpuSignalFailure(input, cause, cpuCeiling);
  }
  if (
    phase !== "decoder" &&
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return readerIntegrityFailure(OPERATION, sourcePath, cause);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return cancelledBy(
      OPERATION,
      carriedReason(artifactFileCancellationCause(cause)),
    );
  if (
    phase === "decoder" &&
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "limit"
  )
    return new AnalysisOutputError(OPERATION, cause.message, {
      cause,
      remediationAction: webNetworkCaptureBudgetRecovery(
        input,
        "max_reply_bytes",
      ),
      diagnostics: {
        boundary: "historical-capture-reply",
        maximum_reply_bytes: captureBudgets().outputBytes,
        budget: webNetworkCaptureBudgetFacts(input, "max_reply_bytes"),
      },
    });
  if (
    phase !== "decoder" &&
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    (cause.reason === "limit" ||
      cause.reason === "format" ||
      cause.reason === "path")
  )
    return new AnalysisInputError(
      OPERATION,
      {
        cause,
        ...(cause.reason === "limit"
          ? {
              diagnostics: {
                budget: webNetworkCaptureBudgetFacts(input, "max_input_bytes"),
              },
              remediationAction: webNetworkCaptureBudgetRecovery(
                input,
                "max_input_bytes",
              ),
            }
          : stableArtifactInputRecovery(cause)),
      },
      [
        {
          path: inputPath,
          reason: cause.reason === "limit" ? "out_of_range" : "invalid_format",
          message:
            cause.reason === "limit"
              ? `${cause.message}. Increase max_input_bytes above ${String(captureBudgets().inputBytes)} on the next call without restarting REA, or select a smaller complete ${sourceLabel}. Reply, worker heap and capture_timeout_ms controls remain separate.`
              : cause.message,
          ...(cause.reason === "limit"
            ? {
                expected: {
                  [descriptorRead
                    ? "maximum_descriptor_set_bytes"
                    : "maximum_capture_bytes"]: captureBudgets().inputBytes,
                },
              }
            : {}),
        },
      ],
    );
  if (
    phase !== "decoder" &&
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(OPERATION, sourcePath, cause.code, {
      cause,
    });
  const selectedPathErrno =
    phase === "decoder" ? undefined : artifactSelectedPathErrno(cause);
  if (selectedPathErrno !== undefined)
    return new AnalysisInputError(OPERATION, { cause }, [
      {
        path: inputPath,
        reason: "invalid_value",
        message: `Selected ${sourceLabel} could not be read (${selectedPathErrno}): ${sourcePath}.`,
      },
    ]);
  if (
    // Stable source reads report owned cancellation with ArtifactReaderFailure.
    // Bare syscall rejections remain physical even when they equal the abort reason.
    phase === "decoder" &&
    origin === "owned-or-classified" &&
    isAbortOf(cause, options?.signal)
  )
    return cancelledBy(OPERATION, options.signal);
  return new ProviderAdapterError(input.format, OPERATION, {
    cause,
    diagnostics: {
      phase,
      capture_path: input.capture_path,
      ...(descriptorRead
        ? { source_path: sourcePath, input_path: inputPath }
        : {}),
      reason: errorMessage(cause),
      ...(origin === "owned-or-classified" &&
      cause instanceof ArtifactReaderFailure
        ? { failure_kind: cause.reason }
        : {}),
      ...(origin === "owned-or-classified" &&
      cause instanceof OwnedCommandFailure &&
      cause.snapshot !== null
        ? {
            ...capturedProviderOutput(cause.snapshot),
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
  heap: CaptureDecoderHeap = DEFAULT_CAPTURE_DECODER_HEAP,
  /** The runtime's own report, which may lie beyond the retained output. */
  exhaustion?: RuntimeExhaustion,
): AnalysisResourceConstraintError => {
  const processMemoryLimitBytes = javaScriptWorkerMemoryLimitBytes(
    heap.oldGenerationMiB,
  );
  const recovery = captureDecoderHeapRecovery(heap);
  const continuingRecovery = captureDecoderHeapContinuingRecovery(heap);
  return historicalCaptureResourceConstraint(
    "memory",
    `${reason}: ${input.capture_path}. No complete capture result is available.`,
    {
      boundary: "historical-capture-decoder",
      capture_path: input.capture_path,
      format: input.format,
      maximum_input_bytes: captureBudgets().inputBytes,
      maximum_reply_bytes: captureBudgets().outputBytes,
      ...(input.format !== "mitmproxy" && NODE_CAPTURE_HEAP_ENFORCED
        ? {
            old_generation_heap_mib: heap.oldGenerationMiB,
            old_generation_heap_source: heap.source,
            semi_space_heap_mib: CAPTURE_DECODER_SEMI_SPACE_MIB,
          }
        : {}),
      ...(input.format !== "mitmproxy" && processMemoryLimitBytes !== null
        ? {
            process_memory_limit_bytes: processMemoryLimitBytes,
          }
        : {}),
      ...(cause instanceof OwnedCommandFailure
        ? {
            observed_exit_code: cause.snapshot?.exitCode ?? null,
            observed_signal: cause.snapshot?.signal ?? null,
          }
        : {}),
    },
    {
      cause,
      ...(exhaustion === undefined
        ? {}
        : {
            diagnostics: {
              runtime_exhaustion_report: runtimeExhaustionReport(exhaustion),
            },
          }),
      ...(input.format !== "mitmproxy" &&
      (NODE_CAPTURE_HEAP_ENFORCED || processMemoryLimitBytes !== null)
        ? {
            limit: analysisSettingLimit(
              "capture.decoder_old_generation_mib",
              heap.oldGenerationMiB,
              heap.source,
            ),
          }
        : {}),
      remediationAction: `Use a smaller capture exported by its producer, or another decoder with sufficient capacity for the original capture. Preserve the original for provenance; a subset does not establish complete-capture coverage.${input.format !== "mitmproxy" ? ` ${recovery}` : ""}${input.format !== "mitmproxy" && processMemoryLimitBytes !== null ? ` The Windows Job Object commit limit for this decoder is ${String(processMemoryLimitBytes)} bytes, ${String(heap.oldGenerationMiB)} MiB plus a 512 MiB Bun reserve.` : ""}`,
      ...(input.format === "mitmproxy"
        ? {}
        : {
            continuingCallerGuidance: {
              remediationAction: `Use a smaller capture exported by its producer, or another decoder with sufficient capacity for the original capture. Preserve the original for provenance; a subset does not establish complete-capture coverage. ${continuingRecovery}${processMemoryLimitBytes !== null ? ` The Windows Job Object commit limit for this decoder is ${String(processMemoryLimitBytes)} bytes, ${String(heap.oldGenerationMiB)} MiB plus a 512 MiB Bun reserve.` : ""}`,
            },
          }),
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            capturedOutput: capturedProviderOutput(cause.snapshot),
          }
        : {}),
    },
  );
};

/** Preserve the exact file owner when capture or descriptor acquisition needs cleanup. */
export const withCaptureReaderCleanup = (
  primary: AnalysisError,
  cause: unknown,
): AnalysisError => {
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    "web-network-capture",
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  bindArtifactFileCleanup(cause, cleanup);
  if (
    cause.reason === "unavailable" &&
    primary instanceof ProviderAdapterError &&
    primary.cause === cause
  ) {
    if (primary.partialObservation !== undefined)
      cleanup.retainPartialObservation(primary.partialObservation);
    return cleanup;
  }
  const composed = analysisErrorWithCleanupDependencies(
    primary,
    cleanup,
    OPERATION,
  );
  bindArtifactFileCleanup(cause, composed);
  return composed;
};
