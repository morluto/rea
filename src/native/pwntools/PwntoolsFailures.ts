import { analysisSettingLimit } from "../../domain/analysisSettingDefinitions.js";
import {
  PWNTOOLS_LIMITS,
  resolvePwntoolsLimits,
  type PwntoolsProducerLimits,
} from "../../domain/native/pwntoolsResourceLimits.js";
import {
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "../../artifacts/ArtifactFileOperation.js";
import { completedStableArtifactObservation } from "../../artifacts/StableArtifactObservation.js";
import { stableArtifactInputRecovery } from "../../artifacts/StableArtifactFailure.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../../domain/analysisErrorBase.js";
import type { ProviderProcessSnapshot } from "../../process/ProviderProcess.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { ProviderSelectionError } from "../../domain/providerSelectionError.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import type { PwntoolsFailureEvidence } from "./PwntoolsResourceLimits.js";
import { nativeDeadlineRecovery } from "../../domain/native/nativeDeadlines.js";
import {
  PWNTOOLS_MEMORY_FAILURE_EXIT,
  PWNTOOLS_FILE_SIZE_FAILURE_EXIT,
} from "./PwntoolsRelease.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "./PwntoolsProviderIdentity.js";

/** Operation identity supplied by each adapter sharing the pwntools boundary. */
export interface PwntoolsFailureContext {
  readonly operation: string;
  readonly providerId: string;
  readonly precedingOutput?: AnalysisCapturedOutput;
  readonly configurationKey?: string;
  readonly timeoutMs?: number;
  readonly producerLimits?: PwntoolsProducerLimits;
  readonly inputBytesSource?:
    | "default"
    | "setting"
    | "runtime"
    | "request"
    | undefined;
}

const pwntoolsInputLimitFact = (
  bytes: number,
  source: PwntoolsFailureContext["inputBytesSource"],
): string => {
  const effective = String(bytes);
  if (source === "request")
    return `Selected producer_limits.input_bytes is ${effective} bytes.`;
  if (source === "runtime")
    return `The runtime pwntools.max_input_bytes ceiling is ${effective} bytes.`;
  if (source === "setting")
    return `REA_PWNTOOLS_MAX_INPUT_BYTES selected ${effective} bytes.`;
  return `The launch default pwntools.max_input_bytes ceiling is ${effective} bytes.`;
};

const pwntoolsInputLimitRecovery = (
  bytes: number,
  source: PwntoolsFailureContext["inputBytesSource"],
): string => {
  const effective = String(bytes);
  const shared =
    "CPU, memory, output and transport allowances remain independent.";
  if (source === "request")
    return `producer_limits.input_bytes is ${effective} bytes for this call. Raise it on the next call (CLI --producer-limits JSON). ${shared}`;
  if (source === "runtime")
    return `pwntools.max_input_bytes is ${effective} bytes (source runtime) and can be changed with update_analysis_settings. The launch seed is REA_PWNTOOLS_MAX_INPUT_BYTES. producer_limits.input_bytes overrides that ceiling on the next call. ${shared}`;
  if (source === "setting")
    return `REA_PWNTOOLS_MAX_INPUT_BYTES is ${effective} bytes (source setting). Change pwntools.max_input_bytes with update_analysis_settings, or set producer_limits.input_bytes on the next call. The built-in default is ${String(PWNTOOLS_LIMITS.input_bytes)} bytes. ${shared}`;
  return `pwntools.max_input_bytes is the launch default of ${effective} bytes and can be changed with update_analysis_settings. The launch seed is REA_PWNTOOLS_MAX_INPUT_BYTES. producer_limits.input_bytes overrides that default on the next call. ${shared}`;
};

/** Recovery identifies the selected controls rather than unrelated wall deadlines. */
export const pwntoolsBudgetRecovery = (
  limits: PwntoolsProducerLimits = resolvePwntoolsLimits(),
): string =>
  `Selected producer_limits: cpu_seconds=${String(limits.cpu_seconds)} seconds, output_bytes=${String(limits.output_bytes)}, diagnostic_bytes=${String(limits.diagnostic_bytes)}, address_space_bytes=${String(limits.address_space_bytes)}, file_bytes=${String(limits.file_bytes)}, input_bytes=${String(limits.input_bytes)} bytes. Increase the exhausted producer_limits field on the next call (CLI --producer-limits JSON); no REA restart is required. Tighter inherited OS limits remain enforced and are not raised by this request. pwntools_timeout_ms changes only the wall deadline.`;

/** Name the file-size cap and any reported effective limit, not address space. */
const fileSizeAllowance = (
  reportedBytes: number | undefined,
  selectedBytes: number,
): string => {
  const cap = String(selectedBytes);
  const inherited =
    "A tighter inherited limit is retained. Increase producer_limits.file_bytes on the next call (CLI --producer-limits JSON); no restart is required. pwntools_timeout_ms does not raise the file-size allowance.";
  return reportedBytes === undefined
    ? `The file-size cap is ${cap} bytes (producer_limits.file_bytes). The effective file_size_bytes limit was not reported. ${inherited}`
    : `The effective file-size allowance is ${String(reportedBytes)} bytes (file_size_bytes). The file-size cap is ${cap} bytes (producer_limits.file_bytes). ${inherited}`;
};

const DEFAULT_CONTEXT = {
  operation: "inspect_binary_layout",
  providerId: PWNTOOLS_PROVIDER_IDENTITY.id,
};

/** Keep read, engine, output and owned-lifecycle failure reasons distinct. */
export const pwntoolsDecoderFailure = (
  cause: unknown,
  phase: string,
  path: string,
  executablePath = path,
  failureEvidence: PwntoolsFailureEvidence = {},
  context: PwntoolsFailureContext = DEFAULT_CONTEXT,
): AnalysisError => {
  const error = classifyPwntoolsDecoderFailure(
    cause,
    phase,
    path,
    executablePath,
    failureEvidence,
    context,
  );
  if (phase === "artifact-read") {
    const observation = completedStableArtifactObservation(cause, path);
    if (observation !== undefined) error.retainPartialObservation(observation);
  }
  return error;
};

const classifyPwntoolsDecoderFailure = (
  cause: unknown,
  phase: string,
  path: string,
  executablePath: string,
  failureEvidence: PwntoolsFailureEvidence,
  context: PwntoolsFailureContext,
): AnalysisError => {
  const limitReport = failureEvidence.limits;
  const limits = context.producerLimits ?? resolvePwntoolsLimits();
  const budgetRecovery = pwntoolsBudgetRecovery(limits);
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof OwnedCommandFailure) {
    const currentOutput =
      cause.snapshot === null
        ? undefined
        : capturedPwntoolsOutput(cause.snapshot);
    const combinedOutput =
      context.precedingOutput === undefined
        ? currentOutput
        : currentOutput === undefined
          ? context.precedingOutput
          : {
              stdout: `[core decoder]\n${context.precedingOutput.stdout}\n[debugger]\n${currentOutput.stdout}`,
              stderr: `[core decoder]\n${context.precedingOutput.stderr}\n[debugger]\n${currentOutput.stderr}`,
              truncated:
                context.precedingOutput.truncated || currentOutput.truncated,
            };
    const outputOptions = {
      ...(combinedOutput === undefined
        ? {}
        : { capturedOutput: combinedOutput }),
      ...(failureEvidence.finalizationFailures === undefined
        ? {}
        : {
            diagnostics: {
              receipt_finalization_failures:
                failureEvidence.finalizationFailures,
            },
          }),
    };
    if (cause.cleanupFailure !== null)
      return new ProviderCleanupError(
        context.providerId,
        cause.resources,
        {
          reason: cause.cleanupFailure,
          ...(combinedOutput === undefined
            ? {}
            : {
                captured_output: { ...combinedOutput },
              }),
          previous_error: {
            failure_kind: cause.reason,
            message: cause.message,
            exit_code: cause.snapshot?.exitCode ?? null,
            signal: cause.snapshot?.signal ?? null,
            stdout: cause.snapshot?.stdout.text ?? null,
            stderr: cause.snapshot?.stderr.text ?? null,
          },
        },
        { operation: context.operation, cause },
      );
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(context.operation, {
        ...outputOptions,
        cause:
          cause.cancellation === undefined
            ? cause.cause
            : cause.cancellation.reason,
      });
    if (cause.reason === "timeout") {
      const timeoutMs = context.timeoutMs ?? PWNTOOLS_LIMITS.command_timeout_ms;
      return new AnalysisTimeoutError(context.operation, timeoutMs, {
        ...outputOptions,
        ...nativeDeadlineRecovery({
          timeoutMs,
          setting: "pwntools_timeout_ms",
          cliFlag: "--pwntools-timeout-ms",
          defaultMs: PWNTOOLS_LIMITS.command_timeout_ms,
          phase: "pwntools command deadline",
          unchanged: budgetRecovery,
        }),
      });
    }
    if (cause.reason === "output-limit")
      return new AnalysisOutputError(context.operation, cause.message, {
        ...outputOptions,
        userMessage: `${cause.message} ${budgetRecovery}`,
        remediationAction: budgetRecovery,
      });
    if (
      cause.reason === "process" &&
      (cause.snapshot?.signal === "SIGXFSZ" ||
        (failureEvidence.marker?.resource === "file-size" &&
          cause.snapshot?.exitCode === PWNTOOLS_FILE_SIZE_FAILURE_EXIT &&
          cause.snapshot.signal === null))
    ) {
      const allowance = fileSizeAllowance(
        limitReport?.limits?.file_size_bytes,
        limits.file_bytes,
      );
      return new AnalysisResourceConstraintError(
        context.operation,
        "file-size",
        (cause.snapshot.signal === "SIGXFSZ"
          ? "Owned Python terminated with SIGXFSZ; the exact signal cause is unknown."
          : "The owned Python bridge reported EFBIG while writing a file; the exact write failure cause is unknown.") +
          (limitReport?.failure === null || limitReport === undefined
            ? ""
            : ` Effective limit report unavailable: ${limitReport.failure}`) +
          ` ${allowance}`,
        limitReport?.limits ?? null,
        {
          ...outputOptions,
          remediationAction: `Review the reported worker file-size limits and write failure. ${allowance} Repeating the unchanged request fails the same way.`,
        },
      );
    }
    if (cause.reason === "process" && cause.snapshot?.signal === "SIGXCPU")
      return new AnalysisResourceConstraintError(
        context.operation,
        "cpu",
        "Owned Python terminated with SIGXCPU; the exact signal cause is unknown." +
          (limitReport?.failure === null || limitReport === undefined
            ? ""
            : ` Effective limit report unavailable: ${limitReport.failure}`) +
          ` Selected producer_limits.cpu_seconds is ${String(limits.cpu_seconds)} seconds; inherited tighter limits remain enforced.`,
        limitReport?.limits ?? null,
        {
          ...outputOptions,
          remediationAction: `Review the reported worker CPU limit and observed signal; the signal alone does not establish exhaustion. Increase producer_limits.cpu_seconds above ${String(limits.cpu_seconds)} on the next call (CLI --producer-limits JSON) when that policy was limiting. No restart is required; a tighter inherited limit remains enforced. pwntools_timeout_ms does not raise CPU admission.`,
        },
      );
    if (
      cause.reason === "process" &&
      failureEvidence.marker?.resource === "memory" &&
      cause.snapshot?.exitCode === PWNTOOLS_MEMORY_FAILURE_EXIT &&
      cause.snapshot.signal === null
    )
      return new AnalysisResourceConstraintError(
        context.operation,
        "memory",
        "The owned Python bridge reported a memory allocation failure without a structured reply; the exact allocation cause is unknown." +
          (limitReport?.failure === null || limitReport === undefined
            ? ""
            : ` Effective limit report unavailable: ${limitReport.failure}`) +
          ` The selected producer_limits.address_space_bytes allowance is ${String(limits.address_space_bytes)} bytes; tighter inherited limits remain enforced.`,
        limitReport?.limits ?? null,
        {
          ...outputOptions,
          remediationAction: `Review the reported worker memory limits and available host memory. ${budgetRecovery}`,
        },
      );
  }
  if (
    cause instanceof Error &&
    "code" in cause &&
    "syscall" in cause &&
    typeof cause.syscall === "string" &&
    cause.syscall.startsWith("spawn ")
  )
    return pwntoolsUnavailable(
      `Selected Python could not launch (${String(cause.code)}): ${executablePath}. Check the configured executable, its interpreter and host execute access.`,
      executablePath,
      String(cause.code),
      undefined,
      context,
    );
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(
        context.operation,
        path,
        cause.message,
        {
          cause,
        },
      );
    if (cause.reason === "cancelled") {
      const error = new AnalysisCancelledError(context.operation, {
        cause: artifactFileCancellationCause(cause),
        cleanup: cause.cleanup,
        partialObservation: cause.partialObservation,
        capturedOutput: context.precedingOutput,
      });
      bindArtifactFileCleanup(cause, error);
      return error;
    }
    if (
      cause.reason === "limit" ||
      cause.reason === "path" ||
      cause.reason === "format"
    )
      return new AnalysisInputError(
        context.operation,
        {
          cause,
          ...stableArtifactInputRecovery(cause),
          ...(cause.reason === "limit"
            ? {
                userMessage: `${cause.message} ${pwntoolsInputLimitFact(limits.input_bytes, context.inputBytesSource)} ${budgetRecovery}`,
                remediationAction: pwntoolsInputLimitRecovery(
                  limits.input_bytes,
                  context.inputBytesSource,
                ),
                limit: analysisSettingLimit(
                  "pwntools.max_input_bytes",
                  limits.input_bytes,
                  context.inputBytesSource,
                ),
              }
            : {}),
        },
        [
          {
            path: ["path"],
            reason:
              cause.reason === "limit" ? "out_of_range" : "invalid_format",
            message:
              cause.reason === "limit"
                ? `${cause.message} REA_PWNTOOLS_MAX_INPUT_BYTES defaults to ${String(PWNTOOLS_LIMITS.input_bytes)} bytes.`
                : cause.message,
          },
        ],
      );
  }
  if (cause instanceof Error && "code" in cause) {
    if (phase === "configuration")
      return pwntoolsUnavailable(
        `Selected Python executable is unavailable (${String(cause.code)}): ${path}. Check the caller-selected path and execute access.`,
        path,
        String(cause.code),
        undefined,
        context,
      );
    if (
      phase === "artifact-read" &&
      (cause.code === "EACCES" || cause.code === "EPERM")
    )
      return new AnalysisAccessDeniedError(
        context.operation,
        path,
        cause.code,
        {
          cause,
        },
      );
    if (
      phase === "artifact-read" &&
      (cause.code === "ENOENT" || cause.code === "ENOTDIR")
    )
      return new AnalysisInputError(context.operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected object could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(context.providerId, context.operation, {
    cause,
    diagnostics: {
      phase,
      path,
      ...(failureEvidence.finalizationFailures === undefined
        ? {}
        : {
            receipt_finalization_failures: failureEvidence.finalizationFailures,
          }),
      ...(context.precedingOutput === undefined
        ? {}
        : { preceding_output: { ...context.precedingOutput } }),
      reason: cause instanceof Error ? cause.message : String(cause),
      ...(failureEvidence.marker === undefined
        ? {}
        : { resource_failure_marker: { ...failureEvidence.marker } }),
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
                  captured_output: {
                    ...capturedPwntoolsOutput(cause.snapshot),
                  },
                }),
          }
        : {}),
    },
  });
};

/** Report caller-selected engine absence with its actual configuration and host constraint. */
export const pwntoolsUnavailable = (
  reason: string,
  path: string,
  systemCode?: string,
  capturedOutput?: AnalysisCapturedOutput,
  context: PwntoolsFailureContext = DEFAULT_CONTEXT,
): ProviderSelectionError =>
  new ProviderSelectionError({
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
    userMessage: reason,
    operation: context.operation,
    reason: "provider_unavailable",
    requestedProviderId: context.providerId,
    candidateIds: [context.providerId],
    rejections: [
      {
        providerId: context.providerId,
        origin: "availability",
        code: "provider_unavailable",
        reason,
        diagnostics: {
          configuration_key: context.configurationKey ?? "REA_PWNTOOLS_PYTHON",
          executable_path: path,
          ...(systemCode === undefined ? {} : { system_code: systemCode }),
        },
      },
    ],
  });

/** Retain bounded text output and the shared supervisor's observed truncation flag. */
export const capturedPwntoolsOutput = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  truncated: snapshot.diagnosticTruncated === true,
});
