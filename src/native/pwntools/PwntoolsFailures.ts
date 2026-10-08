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
import type { PwntoolsLimitReport } from "./PwntoolsResourceLimits.js";
import {
  PWNTOOLS_PROVIDER_IDENTITY,
  PWNTOOLS_LIMITS,
  PWNTOOLS_MEMORY_FAILURE_EXIT,
} from "./PwntoolsRelease.js";

const OPERATION = "inspect_binary_layout";

/** Keep read, engine, output and owned-lifecycle failure reasons distinct. */
export const pwntoolsLayoutFailure = (
  cause: unknown,
  phase: string,
  path: string,
  executablePath = path,
  limitReport?: PwntoolsLimitReport,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof OwnedCommandFailure) {
    const outputOptions =
      cause.snapshot === null
        ? undefined
        : { capturedOutput: capturedPwntoolsOutput(cause.snapshot) };
    if (cause.cleanupFailure !== null)
      return new ProviderCleanupError(
        PWNTOOLS_PROVIDER_IDENTITY.id,
        cause.resources,
        {
          reason: cause.cleanupFailure,
          ...(cause.snapshot === null
            ? {}
            : {
                captured_output: { ...capturedPwntoolsOutput(cause.snapshot) },
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
        { operation: OPERATION, cause },
      );
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(OPERATION, outputOptions);
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        OPERATION,
        PWNTOOLS_LIMITS.timeoutMs,
        outputOptions,
      );
    if (cause.reason === "output-limit")
      return new AnalysisOutputError(OPERATION, cause.message, outputOptions);
    if (cause.reason === "process" && cause.snapshot?.signal === "SIGXCPU")
      return new AnalysisResourceConstraintError(
        OPERATION,
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
      cause.snapshot?.exitCode === PWNTOOLS_MEMORY_FAILURE_EXIT &&
      cause.snapshot.signal === null
    )
      return new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        "The owned Python bridge reported a memory allocation failure without a structured reply; the exact allocation cause and effective resource limits are unknown.",
        null,
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
    );
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
        cause,
      });
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(OPERATION);
    if (
      cause.reason === "limit" ||
      cause.reason === "path" ||
      cause.reason === "format"
    )
      return new AnalysisInputError(OPERATION, { cause }, [
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
      );
    if (
      phase === "artifact-read" &&
      (cause.code === "EACCES" || cause.code === "EPERM")
    )
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (
      phase === "artifact-read" &&
      (cause.code === "ENOENT" || cause.code === "ENOTDIR")
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected object could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(PWNTOOLS_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      phase,
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
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
): ProviderSelectionError =>
  new ProviderSelectionError({
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
    operation: OPERATION,
    reason: "provider_unavailable",
    requestedProviderId: PWNTOOLS_PROVIDER_IDENTITY.id,
    candidateIds: [PWNTOOLS_PROVIDER_IDENTITY.id],
    rejections: [
      {
        providerId: PWNTOOLS_PROVIDER_IDENTITY.id,
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
