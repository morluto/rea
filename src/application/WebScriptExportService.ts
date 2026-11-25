import { decodeStrictUtf8 } from "../domain/strictUtf8.js";

import { z } from "zod";

import {
  ArtifactReaderFailure,
  AnalysisCleanupLeaseGroup,
  type AnalysisCleanupLease,
  type ArtifactResourceScope,
  bindArtifactFileCleanup,
  artifactOperationReason,
  artifactReaderTargetFailure,
} from "../resources/index.js";
import { publishWebScripts } from "./PublishWebScripts.js";
import { selectScriptCapture } from "../domain/webScriptCaptureAdapters.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { WindowsChangeTimeConfigurationError } from "../config/windowsChangeTimeSettle.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import {
  exportWebScriptsInputSchema,
  type ExportWebScriptsInput,
} from "../domain/webScriptExport.js";
import { WebScriptExportError } from "../domain/webScriptExportError.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import { WEB_SCRIPT_EXPORT_PROVIDER as PROVIDER } from "../domain/investigationProviders.js";
import {
  readRegularFile,
  RegularFileReadFailure,
  retryRegularFileCleanup,
} from "../process/RegularFileRead.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
  RegularFileOperationCancelled,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const OPERATION = "export_web_scripts";

interface CaptureRead {
  readonly bytes: Buffer;
  readonly cleanup?: {
    readonly reason: string;
    readonly incomplete: boolean;
    readonly cause: unknown;
    readonly lease?: AnalysisCleanupLease;
  };
}

interface PreparedCapture {
  readonly bytes: Buffer;
  readonly loaded: ReturnType<typeof selectScriptCapture>;
}

/** Export one local capture through the shared CLI/MCP application workflow. */
export const exportWebScripts = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const input = exportWebScriptsInputSchema.safeParse(rawInput);
  return input.success
    ? exportWebScriptsValidated(input.data, resources, options)
    : err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput),
      );
};

/** Publish input already parsed by a named adapter contract. */
export const exportWebScriptsValidated = async (
  input: ExportWebScriptsInput,
  resources: ArtifactResourceScope,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  try {
    if (options.signal?.aborted)
      return err(cancelledBy(OPERATION, options.signal));
    const prepared = await prepareCapture(
      input.capture_path,
      resources,
      options.signal,
    );
    if (!prepared.ok) return prepared;
    const { bytes, loaded } = prepared.value;
    if (options.signal?.aborted)
      return err(cancelledBy(OPERATION, options.signal));
    const sha256 = sha256Hex(bytes);
    const result = await publishWebScripts(input, loaded, sha256, {
      resources,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (options.signal?.aborted === true)
      return err(
        cancelledBy(OPERATION, options.signal, {
          partialObservation: { kind: "web-script-export", result },
        }),
      );
    return ok(
      createEvidence(
        { path: input.capture_path, sha256, format: "file" },
        PROVIDER,
        {
          predicateType: "rea.web-script-export",
          operation: OPERATION,
          parameters: {
            capture_path: input.capture_path,
            output_directory: input.output_directory,
          },
          result,
          rawResult: null,
          confidence: "derived",
          authority: "historical-reference",
          limitations: result.limitations,
          locations: [{ kind: "artifact-path", path: result.manifest.path }],
          evidenceLinks:
            loaded.sourceEvidenceId === null ? [] : [loaded.sourceEvidenceId],
        },
      ),
    );
  } catch (cause: unknown) {
    return err(mapExportFailure(cause, input));
  }
};

const prepareCapture = async (
  path: string,
  resources: ArtifactResourceScope,
  signal: AbortSignal | undefined,
): Promise<Result<PreparedCapture, AnalysisError>> => {
  const read = await resources.run(() => readCapture(path, resources, signal));
  if (!read.ok) return read;
  const cleanup = read.value.cleanup;
  const loaded = parseCapture(
    read.value.bytes,
    cleanup === undefined || cleanup.incomplete
      ? undefined
      : { cause: cleanup.cause },
  );
  if (!loaded.ok)
    return err(
      cleanup?.incomplete === true
        ? incompleteCaptureCleanup(loaded.error, path, cleanup)
        : loaded.error,
    );
  if (cleanup !== undefined) {
    const primary = new WebScriptExportError(
      "io",
      path,
      `Capture handle close failed: ${cleanup.reason}`,
      { cause: cleanup.cause },
    );
    return err(
      cleanup.incomplete
        ? incompleteCaptureCleanup(primary, path, cleanup)
        : primary,
    );
  }
  return ok({ bytes: read.value.bytes, loaded: loaded.value });
};

const mapExportFailure = (
  cause: unknown,
  input: ExportWebScriptsInput,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    const primary =
      cause.cancellation !== undefined
        ? cancelledBy(OPERATION, carriedReason(cause.cancellation.reason), {
            partialObservation: cause.partialObservation,
          })
        : (artifactReaderTargetFailure(OPERATION, input.capture_path, cause) ??
          new WebScriptExportError(
            artifactOperationReason(cause),
            input.output_directory,
            cause.message,
            { cause, partialObservation: cause.partialObservation },
          ));
    if (cause.cleanup === undefined) return primary;
    const error = analysisErrorWithCleanupFailure(
      primary,
      new ProviderCleanupError(
        PROVIDER.id,
        cause.cleanup.resources,
        { reason: cause.cleanup.reason },
        { cause, operation: OPERATION },
      ),
      OPERATION,
    );
    bindArtifactFileCleanup(cause, error);
    return error;
  }
  if (cause instanceof z.ZodError)
    return new AnalysisOutputError(OPERATION, cause.message, { cause });
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string"
  )
    return new WebScriptExportError(
      "io",
      `${input.capture_path} → ${input.output_directory}`,
      cause.message,
      { cause },
    );
  return new ProviderAdapterError(PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      capture_path: input.capture_path,
      output_directory: input.output_directory,
      error_name: cause instanceof Error ? cause.name : "UnknownError",
      error_message:
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "Unknown script export failure",
    },
  });
};

/**
 * Read the caller-selected capture. A missing, non-file or unreadable
 * selection is a caller or host-permission failure, not an export failure.
 */
const readCapture = async (
  path: string,
  resources: ArtifactResourceScope,
  signal: AbortSignal | undefined,
): Promise<Result<CaptureRead, AnalysisError>> => {
  try {
    return ok({
      bytes: await readRegularFile(path, {
        signal,
        cancellationFailure: (reason) =>
          new RegularFileOperationCancelled(reason),
      }),
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) {
      const retry = await retryRegularFileCleanup(cause, resources, signal);
      const cleanup = {
        reason: retry.cleanup?.reason ?? errorMessage(cause.cleanupCause),
        incomplete: retry.cleanup !== undefined,
        cause: cause.cleanupCause,
        ...(retry.cleanupLease === undefined
          ? {}
          : { lease: retry.cleanupLease }),
      };
      if (cause.outcome.kind === "completed") {
        const cancellation =
          regularFileCancellation(cause) ??
          (signal?.aborted === true ? { reason: signal.reason } : undefined);
        if (cancellation !== undefined) {
          const primary = cancelledBy(
            OPERATION,
            carriedReason(cancellation.reason),
          );
          return err(
            retry.cleanup === undefined
              ? primary
              : incompleteCaptureCleanup(primary, path, cleanup),
          );
        }
        return ok({ bytes: cause.outcome.value as Buffer, cleanup });
      }
      const primary = captureReadErrorWithCancellation(
        captureReadFailure(
          path,
          cause,
          retry.cleanup === undefined
            ? { cause: cause.cleanupCause }
            : undefined,
        ),
        signal,
      );
      return err(
        retry.cleanup === undefined
          ? primary
          : incompleteCaptureCleanup(primary, path, cleanup),
      );
    }
    return err(
      captureReadErrorWithCancellation(captureReadFailure(path, cause), signal),
    );
  }
};

const captureReadErrorWithCancellation = (
  error: AnalysisError,
  signal: AbortSignal | undefined,
): AnalysisError =>
  signal?.aborted === true
    ? analysisErrorWithCancellation(error, cancelledBy(OPERATION, signal))
    : error;

const captureReadFailure = (
  path: string,
  failure: unknown,
  closeFailure?: { readonly cause: unknown },
): AnalysisError => {
  const cancellation = regularFileCancellation(failure);
  if (cancellation !== undefined)
    return cancelledBy(OPERATION, carriedReason(cancellation.reason));
  const primary =
    failure instanceof RegularFileCleanupFailure &&
    failure.outcome.kind === "failed"
      ? (failure.operationFailure ?? failure.outcome.cause)
      : failure;
  const cause =
    primary instanceof RegularFileReadFailure
      ? primary.operationCause
      : primary;
  const causeWithClose =
    closeFailure === undefined
      ? cause
      : new AggregateError(
          [cause, closeFailure.cause],
          "Capture read and file-handle close both failed",
          { cause },
        );
  if (cause instanceof WindowsChangeTimeConfigurationError) {
    if (closeFailure === undefined) return cause;
    return new ConfigurationError(cause.message, {
      cause: causeWithClose,
      settings: cause.settings,
      ...(cause.remediationAction === undefined
        ? {}
        : { remediationAction: cause.remediationAction }),
    });
  }
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : "";
  if (code === "EACCES" || code === "EPERM")
    return new AnalysisAccessDeniedError(OPERATION, path, code, {
      cause: causeWithClose,
    });
  if (
    cause instanceof NonRegularFileReadError ||
    cause instanceof RegularFileChangedError ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EISDIR" ||
    code === "ENXIO"
  )
    return new AnalysisInputError(OPERATION, { cause: causeWithClose }, [
      {
        path: ["capture_path"],
        reason: "invalid_value",
        message:
          cause instanceof NonRegularFileReadError && code !== "EISDIR"
            ? cause.message
            : code === "EISDIR"
              ? `Selected capture is a directory, not a file: ${path}`
              : `Selected capture could not be read (${code}): ${path}`,
      },
    ]);
  if (code !== "")
    return new WebScriptExportError("io", path, errorMessage(cause), {
      cause: causeWithClose,
    });
  return new ProviderAdapterError(PROVIDER.id, OPERATION, {
    cause: causeWithClose,
    diagnostics: {
      capture_path: path,
      error_name: cause instanceof Error ? cause.name : "UnknownError",
      error_message: errorMessage(cause),
    },
  });
};

const incompleteCaptureCleanup = (
  primary: AnalysisError,
  path: string,
  cleanup: NonNullable<CaptureRead["cleanup"]>,
): AnalysisError => {
  const error = analysisErrorWithCleanupFailure(
    primary,
    new ProviderCleanupError(
      PROVIDER.id,
      [path],
      { reason: cleanup.reason },
      { cause: cleanup.cause, operation: OPERATION },
    ),
    OPERATION,
  );
  if (cleanup.lease !== undefined)
    new AnalysisCleanupLeaseGroup(error, [cleanup.lease]);
  return error;
};

const parseCapture = (
  bytes: Buffer,
  closeFailure?: { readonly cause: unknown },
): Result<ReturnType<typeof selectScriptCapture>, AnalysisError> => {
  try {
    const text = decodeStrictUtf8(bytes, "preserve");
    const json = safeParseJson(text);
    if (!json.ok) throw new TypeError(json.error);
    return ok(selectScriptCapture(json.value));
  } catch (cause: unknown) {
    const causeWithClose =
      closeFailure === undefined
        ? cause
        : new AggregateError(
            [cause, closeFailure.cause],
            "Capture parse and file-handle close both failed",
            { cause },
          );
    return err(
      new AnalysisInputError(OPERATION, { cause: causeWithClose }, [
        {
          path: ["capture_path"],
          reason: "invalid_format",
          message:
            cause instanceof Error
              ? cause.message
              : "Capture is not valid UTF-8 JSON evidence.",
        },
      ]),
    );
  }
};
