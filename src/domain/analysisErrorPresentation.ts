import {
  AnalysisInputError,
  ArtifactOperationError,
  BinaryTargetError,
  BrowserObservationError,
  ConfigurationError,
  EvidenceFileError,
  EvidenceIntegrityError,
  EvidenceLimitError,
  HopperRemoteError,
  InvestigationWorkspaceError,
  NoBinaryOpenError,
  PermissionRequiredError,
  ProviderSelectionError,
  ReplayPlanStaleError,
  UnknownRegistryError,
  type AnalysisError,
  type AnalysisErrorProjection,
  type AnalysisErrorTag,
} from "./errors.js";

export const analysisErrorRemediationAction = (
  error: AnalysisError,
): string => {
  if (error instanceof AnalysisInputError)
    return "Correct the listed arguments and retry.";
  if (error instanceof ReplayPlanStaleError)
    return "Review the rebuilt replay plan and explicitly approve its new digest.";
  if (error instanceof PermissionRequiredError)
    return error.restartRequired
      ? "Add the exact missing scope to the administrator configuration, then restart the registered MCP server or client."
      : error.elicitationSupported
        ? "Approve the exact missing scope, then retry the operation."
        : "Add the exact missing scope beneath the administrator ceiling, then retry.";
  return analysisErrorUserMessage(error);
};

export const analysisErrorCategory = (
  error: AnalysisError,
): AnalysisErrorProjection["category"] => {
  if (error instanceof ReplayPlanStaleError) return "integrity_mismatch";
  if (error instanceof PermissionRequiredError) return "permission_required";
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
    return "permission_required";
  if (error instanceof ArtifactOperationError)
    return artifactErrorCategory(error.reason);
  if (error instanceof EvidenceFileError && error.reason === "disabled")
    return "unavailable";
  if (error instanceof InvestigationWorkspaceError)
    return investigationWorkspaceCategory(error.reason);
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

const investigationWorkspaceCategory = (
  reason: InvestigationWorkspaceError["reason"],
): AnalysisErrorProjection["category"] => {
  if (
    reason === "disabled" ||
    reason === "outside-root" ||
    reason === "not-file"
  )
    return "unavailable";
  if (reason === "too-large") return "truncated";
  if (reason === "invalid-json" || reason === "integrity")
    return "integrity_mismatch";
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
  AnalysisCapabilityUnavailableError: "unsupported_provider",
  ProviderSelectionError: "unsupported_provider",
  EvidenceIntegrityError: "integrity_mismatch",
  EvidenceLimitError: "truncated",
  AnalysisCancelledError: "cancelled",
  HopperCancelledError: "cancelled",
  AnalysisTimeoutError: "timeout",
  HopperTimeoutError: "timeout",
  NoBinaryOpenError: "unavailable",
  BinaryTargetError: "unavailable",
};

export const analysisErrorUserMessage = (error: AnalysisError): string => {
  if (error instanceof ReplayPlanStaleError)
    return "The controlled replay plan changed before execution. Refresh the current state and try again.";
  if (error instanceof PermissionRequiredError)
    return "This operation needs additional local permission. Review the requested scope and remediation.";
  if (error instanceof AnalysisInputError)
    return "Analysis input is invalid. Check the arguments and try again.";
  if (error.userMessage !== undefined) return error.userMessage;
  const standardMessage = standardErrorMessage(error._tag);
  if (standardMessage !== undefined) return standardMessage;
  if (error instanceof ArtifactOperationError)
    return artifactMessage(error.reason);
  if (error instanceof EvidenceIntegrityError)
    return "Evidence is invalid or has changed. Recreate or re-import it, then try again.";
  if (error instanceof EvidenceLimitError)
    return "Evidence is too large for this session. Reduce the evidence set and try again.";
  if (error instanceof EvidenceFileError)
    return evidenceFileMessage(error.reason);
  if (error instanceof InvestigationWorkspaceError)
    return investigationWorkspaceMessage(error.reason);
  if (error instanceof UnknownRegistryError)
    return "Evidence state changed before the update completed. Refresh the current state and try again.";
  if (error instanceof ConfigurationError)
    return "REA configuration is invalid. Run `rea doctor` and fix the reported setting.";
  if (error instanceof NoBinaryOpenError) return error.message;
  if (error instanceof BinaryTargetError)
    return "REA could not open that app or binary. Check that the path exists, is readable, and points to a supported file.";
  if (error._tag === "ProcessCaptureError")
    return (
      error.userMessage ??
      "Process capture could not complete. Run `rea doctor`, then review capture policy and try again."
    );
  return "Analysis could not complete. Run `rea doctor`, then try again.";
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
    return "Artifact path is not allowed. Choose a path inside the artifact and try again.";
  if (reason === "unavailable")
    return "Artifact format is not available on this system. Choose another artifact or supported environment.";
  if (reason === "format" || reason === "integrity")
    return "Artifact is invalid or has changed. Get a fresh copy and try again.";
  return "Artifact could not be read or written. Check file access and try again.";
};

const evidenceFileMessage = (reason: EvidenceFileError["reason"]): string => {
  if (reason === "disabled")
    return "Evidence file access is disabled. Enable an evidence directory or use inline evidence.";
  if (reason === "outside-root")
    return "Evidence path is outside the allowed directory. Choose a path inside the configured evidence directory.";
  if (reason === "not-file")
    return "Evidence path does not point to a file. Choose an evidence file and try again.";
  if (reason === "too-large")
    return "Evidence file is too large. Reduce its size and try again.";
  if (reason === "exists")
    return "Evidence file already exists. Choose another path or allow overwrite.";
  if (reason === "invalid-json")
    return "Evidence file is not valid JSON. Repair or recreate the file and try again.";
  return "Evidence file could not be accessed. Check file permissions and try again.";
};

const investigationWorkspaceMessage = (
  reason: InvestigationWorkspaceError["reason"],
): string => {
  if (reason === "disabled")
    return "Investigation workspace access is disabled. Configure a workspace directory and try again.";
  if (reason === "outside-root")
    return "Investigation workspace is outside the allowed directory. Choose a configured workspace directory and try again.";
  if (reason === "not-file")
    return "Investigation workspace path is not a file. Choose a workspace file and try again.";
  if (reason === "too-large")
    return "Investigation workspace is too large. Reduce its size and try again.";
  if (reason === "invalid-json" || reason === "integrity")
    return "Investigation workspace is invalid or has changed. Recreate or repair it, then try again.";
  if (reason === "locked")
    return "Another investigation update is in progress. Try again when it finishes.";
  if (reason === "revision-conflict" || reason === "name-conflict")
    return "Investigation workspace state changed. Refresh the current state and try again.";
  return "Investigation workspace could not be accessed. Check file permissions and try again.";
};

const KNOWN_ERROR_TAGS = {
  AnalysisProtocolError: true,
  AnalysisInputError: true,
  AnalysisOutputError: true,
  AnalysisCapabilityUnavailableError: true,
  AnalysisCancelledError: true,
  AnalysisTimeoutError: true,
  ProviderSelectionError: true,
  ProviderAdapterError: true,
  BrowserObservationError: true,
  ArtifactOperationError: true,
  ProcessCaptureError: true,
  EvidenceIntegrityError: true,
  EvidenceLimitError: true,
  EvidenceFileError: true,
  InvestigationWorkspaceError: true,
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
  PermissionRequiredError: true,
  ReplayPlanStaleError: true,
} as const satisfies Readonly<Record<AnalysisErrorTag, true>>;

export const assertKnownAnalysisErrorTag = (tag: AnalysisErrorTag): void => {
  if (KNOWN_ERROR_TAGS[tag] !== true)
    throw new TypeError("Unknown analysis error tag");
};
