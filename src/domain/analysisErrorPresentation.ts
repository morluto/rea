import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "./analysisErrorCore.js";
import { ArtifactOperationError } from "./artifactOperationError.js";
import {
  BinaryTargetError,
  ConfigurationError,
  NoBinaryOpenError,
} from "./configurationErrors.js";
import { BrowserObservationError } from "./browserObservationError.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
  EvidenceReferenceError,
} from "./evidenceErrors.js";
import {
  HopperRemoteError,
  HopperProcessError,
  HopperStartError,
  HopperTimeoutError,
} from "./hopperErrors.js";
import { ProviderSelectionError } from "./providerSelectionError.js";
import { UnknownRegistryError } from "./unknownRegistryError.js";
import {
  type AnalysisError,
  type AnalysisErrorTag,
} from "./analysisErrorBase.js";
import { type AnalysisErrorProjection } from "./analysisErrorProjection.js";

export const analysisErrorRemediationAction = (
  error: AnalysisError,
): string => {
  if (error instanceof AnalysisResourceConstraintError)
    return error.resource === "cpu"
      ? "Review the reported worker CPU limits and observed signal. Retry with sufficient CPU time or a smaller artifact; REA retains tighter inherited limits."
      : error.resource === "file-size"
        ? "Review the reported worker file-size limits and write failure. Retry with a sufficient file-size allowance for the evidence reply; REA retains tighter inherited limits."
        : "Review the reported worker memory limits and available host memory. Retry with sufficient memory or a smaller artifact; REA retains tighter inherited limits.";
  if (error instanceof HopperTimeoutError)
    return error.providerState === "busy"
      ? "Check binary_session.analysis_activity, wait for the active Hopper request to finish, then retry."
      : "Check binary_session for Hopper health, then retry the operation.";
  if (error instanceof HopperProcessError)
    return "Check binary_session provider health. Restart the owned Hopper process only when it has stopped.";
  if (error instanceof HopperStartError)
    return error.ownerRunId === undefined
      ? "Check the Hopper launcher and target details, then retry opening the target."
      : `Use the active REA session ${error.ownerRunId} or close it before opening this target again.`;
  if (error instanceof HopperRemoteError)
    return "Review the Hopper diagnostic details; correct the request or retry if the failure was transient.";
  if (error instanceof EvidenceReferenceError)
    return "Use an exact Evidence reference retained by this session, supply the complete inline Evidence, re-run its producer, or import its Evidence bundle. close_binary clears retained records.";
  if (
    error instanceof BinaryTargetError &&
    error.constraint === "directory_requires_file"
  )
    return "For a JavaScript/Electron application directory, call analyze_javascript_application with input_path or run `rea analyze <directory>`. For binary analysis, select its executable file.";
  if (error instanceof AnalysisAccessDeniedError)
    return "Check the current process's read access to the selected path. Retry with a readable local file.";
  if (error instanceof AnalysisArtifactChangedError)
    return "Wait until the selected file is stable, then retry this operation.";
  if (error instanceof AnalysisInputError)
    return "Correct the listed arguments and retry.";
  if (error instanceof UnknownRegistryError && error.reason === "not-found")
    return "Check that the unknown_id belongs to this session, then retry.";
  return analysisErrorUserMessage(error);
};

export const analysisErrorCategory = (
  error: AnalysisError,
): AnalysisErrorProjection["category"] => {
  if (
    error instanceof ProviderSelectionError &&
    error.reason === "provider_unavailable"
  )
    return "unavailable";
  if (error._tag === "ProcessCaptureError")
    return error.userCategory ?? "execution_failure";
  if (error instanceof BrowserObservationError)
    return browserErrorCategory(error.reason);
  if (
    error instanceof HopperRemoteError &&
    error.diagnosticType === "authorization"
  )
    return "unavailable";
  if (error instanceof HopperProcessError || error instanceof HopperStartError)
    return "unavailable";
  if (error instanceof ArtifactOperationError)
    return artifactErrorCategory(error.reason);
  return STATIC_ERROR_CATEGORIES[error._tag] ?? "execution_failure";
};

const browserErrorCategory = (
  reason: BrowserObservationError["reason"],
): AnalysisErrorProjection["category"] => {
  if (reason === "payload_limit") return "truncated";
  if (
    reason === "target_not_found" ||
    reason === "target_not_allowed" ||
    reason === "target_changed" ||
    reason === "endpoint_unreachable" ||
    reason === "disconnected"
  )
    return "unavailable";
  return "execution_failure";
};

const artifactErrorCategory = (
  reason: ArtifactOperationError["reason"],
): AnalysisErrorProjection["category"] => {
  if (reason === "integrity") return "integrity_mismatch";
  if (reason === "limit") return "truncated";
  if (reason === "cancelled") return "cancelled";
  if (reason === "unavailable") return "unavailable";
  return "execution_failure";
};

const STATIC_ERROR_CATEGORIES: Readonly<
  Partial<Record<AnalysisErrorTag, AnalysisErrorProjection["category"]>>
> = {
  AnalysisInputError: "invalid_input",
  AnalysisAccessDeniedError: "unavailable",
  AnalysisArtifactChangedError: "integrity_mismatch",
  AnalysisCapabilityUnavailableError: "unsupported_provider",
  ProviderSelectionError: "unsupported_provider",
  EvidenceIntegrityError: "integrity_mismatch",
  AnalysisCancelledError: "cancelled",
  HopperCancelledError: "cancelled",
  AnalysisTimeoutError: "timeout",
  AnalysisResourceConstraintError: "resource_constraint",
  HopperTimeoutError: "timeout",
  NoBinaryOpenError: "unavailable",
  BinaryTargetError: "unavailable",
};

export const analysisErrorUserMessage = (error: AnalysisError): string => {
  if (error instanceof AnalysisResourceConstraintError) return error.reason;
  if (error instanceof AnalysisAccessDeniedError)
    return "Host filesystem permissions denied read access to the selected path.";
  if (error instanceof AnalysisArtifactChangedError)
    return "The selected artifact changed during acquisition; no stable snapshot was decoded.";
  if (error instanceof AnalysisInputError)
    return "Analysis input is invalid. Check the arguments and try again.";
  const hopperMessage = hopperErrorUserMessage(error);
  if (hopperMessage !== undefined) return hopperMessage;
  if (error.userMessage !== undefined) return error.userMessage;
  const standardMessage = standardErrorMessage(error._tag);
  if (standardMessage !== undefined) return standardMessage;
  if (error instanceof ArtifactOperationError)
    return artifactMessage(error.reason);
  if (error instanceof EvidenceReferenceError)
    return error.reason === "missing"
      ? `Evidence ${error.evidenceId} is not retained in this session. Supply complete inline Evidence, re-run its producer, or import its bundle before using this reference.`
      : `Evidence ${error.evidenceId} does not match the requested reference (${error.reason}). Check the expected and actual identity in the diagnostic details.`;
  if (error instanceof EvidenceIntegrityError)
    return "Evidence is invalid or has changed. Recreate or re-import it, then try again.";
  if (error instanceof EvidenceFileError)
    return evidenceFileMessage(error.reason);
  if (error instanceof UnknownRegistryError && error.reason === "not-found")
    return "The requested residual unknown does not exist in this session. Check the unknown_id and try again.";
  if (error instanceof UnknownRegistryError)
    return "Evidence state changed before the update completed. Refresh the current state and try again.";
  if (error instanceof ConfigurationError)
    return "REA configuration is invalid. Run `rea doctor` and fix the reported setting.";
  if (error instanceof NoBinaryOpenError) return error.message;
  if (error instanceof BinaryTargetError)
    return error.constraint === "directory_requires_file"
      ? "open_binary accepts files and macOS app bundles. This target is a directory; JavaScript/Electron application directories can be analyzed directly with analyze_javascript_application or `rea analyze <directory>`."
      : `${error.message}. Check that the path exists, is readable, and points to a supported file.`;
  if (error._tag === "ProcessCaptureError")
    return (
      error.userMessage ??
      "Process capture could not complete. Run `rea doctor`, then review capture policy and try again."
    );
  return "Analysis could not complete. Run `rea doctor`, then try again.";
};

const hopperErrorUserMessage = (error: AnalysisError): string | undefined => {
  if (error instanceof HopperTimeoutError) {
    const request = error.operation ?? "startup";
    return error.providerState === "busy"
      ? `Hopper timed out during ${request} while the provider remained busy. Check binary_session.analysis_activity, wait for the active request to finish, then retry.`
      : `Hopper timed out during ${request} before it started. Check binary_session for provider health, then retry.`;
  }
  if (error instanceof HopperProcessError)
    return `Hopper stopped during ${error.operation ?? "connection"}${error.exitCode === null ? "; its exit was not observed" : ` with exit code ${String(error.exitCode)}`}.${error.userMessage === undefined ? "" : ` ${error.userMessage}`} Check binary_session provider health before retrying.`;
  if (error instanceof HopperStartError)
    return (
      error.userMessage ??
      "Hopper could not start. Check the launcher and target details, then retry opening the target."
    );
  if (error instanceof HopperRemoteError)
    return `Hopper ${error.operation ?? "analysis"} failed (${String(error.code)}, ${error.diagnosticType}): ${error.safeMessage}`;
  return undefined;
};

const standardErrorMessage = (tag: AnalysisErrorTag): string | undefined => {
  if (UNREADABLE_OUTPUT_TAGS.has(tag))
    return "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.";
  if (UNSUPPORTED_PROVIDER_TAGS.has(tag))
    return "This analysis is unavailable for the current target. Choose another analysis or target.";
  if (CANCELLED_TAGS.has(tag))
    return "Analysis was cancelled. Start it again when ready.";
  if (TIMEOUT_TAGS.has(tag))
    return "Analysis took too long. Try a smaller request, then run `rea doctor` if it continues.";
  if (ADAPTER_FAILURE_TAGS.has(tag))
    return "Analysis could not complete. Retry once; if it continues, run `rea doctor`.";
  if (START_FAILURE_TAGS.has(tag))
    return "Analysis could not start or stopped unexpectedly. Run `rea doctor`, then try again.";
  return undefined;
};

const UNREADABLE_OUTPUT_TAGS: ReadonlySet<AnalysisErrorTag> = new Set([
  "AnalysisProtocolError",
  "AnalysisOutputError",
  "HopperProtocolError",
]);
const UNSUPPORTED_PROVIDER_TAGS: ReadonlySet<AnalysisErrorTag> = new Set([
  "AnalysisCapabilityUnavailableError",
  "ProviderSelectionError",
]);
const CANCELLED_TAGS: ReadonlySet<AnalysisErrorTag> = new Set([
  "AnalysisCancelledError",
  "HopperCancelledError",
]);
const TIMEOUT_TAGS: ReadonlySet<AnalysisErrorTag> = new Set([
  "AnalysisTimeoutError",
  "HopperTimeoutError",
]);
const ADAPTER_FAILURE_TAGS: ReadonlySet<AnalysisErrorTag> = new Set([
  "ProviderAdapterError",
  "HopperRemoteError",
]);
const START_FAILURE_TAGS: ReadonlySet<AnalysisErrorTag> = new Set([
  "HopperProcessError",
  "HopperStartError",
]);

const artifactMessage = (reason: ArtifactOperationError["reason"]): string => {
  if (reason === "cancelled")
    return "Artifact operation was cancelled. Start it again when ready.";
  if (reason === "limit")
    return "Artifact is too large to process safely. Narrow the requested path or use a smaller artifact.";
  if (reason === "path")
    return "Artifact contains an unsafe or conflicting internal path. Inspect the reported path and correct the artifact before retrying.";
  if (reason === "unavailable")
    return "Artifact processing is unavailable for the current target or host. Check artifact support and required tools.";
  if (reason === "format" || reason === "integrity")
    return "Artifact is invalid or has changed. Get a fresh copy and try again.";
  return "Artifact could not be read or written. Check file access and try again.";
};

const evidenceFileMessage = (reason: EvidenceFileError["reason"]): string => {
  if (reason === "not-file")
    return "Evidence path does not point to a regular file. Choose a file and try again.";
  if (reason === "exists")
    return "Evidence file already exists. Choose another path or allow overwrite.";
  if (reason === "invalid-json")
    return "Evidence file is not valid JSON. Repair or recreate the file and try again.";
  return "Evidence file could not be accessed. Check file permissions and try again.";
};

const KNOWN_ERROR_TAGS = {
  AnalysisProtocolError: true,
  AnalysisInputError: true,
  AnalysisAccessDeniedError: true,
  AnalysisArtifactChangedError: true,
  AnalysisOutputError: true,
  AnalysisCapabilityUnavailableError: true,
  AnalysisCancelledError: true,
  AnalysisTimeoutError: true,
  AnalysisResourceConstraintError: true,
  ProviderSelectionError: true,
  ProviderAdapterError: true,
  BrowserObservationError: true,
  ArtifactOperationError: true,
  ProcessCaptureError: true,
  EvidenceIntegrityError: true,
  EvidenceFileError: true,
  UnknownRegistryError: true,
  HopperTimeoutError: true,
  HopperCancelledError: true,
  HopperProtocolError: true,
  HopperRemoteError: true,
  HopperProcessError: true,
  HopperStartError: true,
  ConfigurationError: true,
  NoBinaryOpenError: true,
  BinaryTargetError: true,
} as const satisfies Readonly<Record<AnalysisErrorTag, true>>;

export const assertKnownAnalysisErrorTag = (tag: AnalysisErrorTag): void => {
  if (KNOWN_ERROR_TAGS[tag] !== true)
    throw new TypeError("Unknown analysis error tag");
};
