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
import {
  PWNTOOLS_PROVIDER_IDENTITY,
  PWNTOOLS_LIMITS,
  PWNTOOLS_MEMORY_FAILURE_EXIT,
  PWNTOOLS_FILE_SIZE_FAILURE_EXIT,
} from "./PwntoolsRelease.js";

/** Operation identity supplied by each adapter sharing the pwntools boundary. */
export interface PwntoolsFailureContext {
  readonly operation: string;
  readonly providerId: string;
  readonly precedingOutput?: AnalysisCapturedOutput;
}
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
  const limitReport = failureEvidence.limits;
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
    const outputOptions =
      combinedOutput === undefined
        ? undefined
        : { capturedOutput: combinedOutput };
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
      return new AnalysisCancelledError(context.operation, outputOptions);
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        context.operation,
        PWNTOOLS_LIMITS.timeoutMs,
        outputOptions,
      );
    if (cause.reason === "output-limit")
      return new AnalysisOutputError(
        context.operation,
        cause.message,
        outputOptions,
      );
    if (
      cause.reason === "process" &&
      (cause.snapshot?.signal === "SIGXFSZ" ||
        (failureEvidence.marker?.resource === "file-size" &&
          cause.snapshot?.exitCode === PWNTOOLS_FILE_SIZE_FAILURE_EXIT &&
          cause.snapshot.signal === null))
    )
      return new AnalysisResourceConstraintError(
        context.operation,
        "file-size",
        (cause.snapshot.signal === "SIGXFSZ"
          ? "Owned Python terminated with SIGXFSZ; the exact signal cause is unknown."
          : "The owned Python bridge reported EFBIG while writing a file; the exact write failure cause is unknown.") +
          (limitReport?.failure === null || limitReport === undefined
            ? ""
            : ` Effective limit report unavailable: ${limitReport.failure}`),
        limitReport?.limits ?? null,
        outputOptions,
      );
    if (cause.reason === "process" && cause.snapshot?.signal === "SIGXCPU")
      return new AnalysisResourceConstraintError(
        context.operation,
        "cpu",
        "Owned Python terminated with SIGXCPU; the exact signal cause is unknown." +
          (limitReport?.failure === null || limitReport === undefined
            ? ""
            : ` Effective limit report unavailable: ${limitReport.failure}`),
        limitReport?.limits ?? null,
        outputOptions,
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
            : ` Effective limit report unavailable: ${limitReport.failure}`),
        limitReport?.limits ?? null,
        outputOptions,
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
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(context.operation);
    if (
      cause.reason === "limit" ||
      cause.reason === "path" ||
      cause.reason === "format"
    )
      return new AnalysisInputError(context.operation, { cause }, [
        {
          path: ["path"],
          reason: cause.reason === "limit" ? "out_of_range" : "invalid_format",
          message: cause.message,
        },
      ]);
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
    operation: context.operation,
    reason: "provider_unavailable",
    requestedProviderId: context.providerId,
    candidateIds: [context.providerId],
    rejections: [
      {
        providerId: context.providerId,
        code: "provider_unavailable",
        reason,
        diagnostics: {
          configuration_key: "REA_PWNTOOLS_PYTHON",
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
