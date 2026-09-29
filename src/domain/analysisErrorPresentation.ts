import {
  AnalysisInputError,
  ArtifactOperationError,
  BinaryTargetError,
  BrowserObservationError,
  ConfigurationError,
  EvidenceFileError,
  EvidenceIntegrityError,
  HopperRemoteError,
  HopperProcessError,
  HopperStartError,
  HopperTimeoutError,
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
  if (error instanceof AnalysisInputError)
    return "Correct the listed arguments and retry.";
  if (error instanceof UnknownRegistryError && error.reason === "not-found")
    return "Check that the unknown_id belongs to this session, then retry.";
  if (error instanceof ReplayPlanStaleError)
    return "Review the rebuilt replay plan and explicitly approve its new digest.";
  if (error instanceof PermissionRequiredError) {
    switch (error.remediation) {
      case "configure":
        return "Add the exact missing scope beneath the administrator ceiling, then retry.";
      case "elicit":
        return "Approve the exact missing scope, then retry the operation.";
      case "restart":
        return "Add the exact missing scope to the administrator configuration, then restart the registered MCP server or client.";
    }
  }
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
  if (reason === "policy" || reason === "unavailable") return "unavailable";
  return "execution_failure";
};

const STATIC_ERROR_CATEGORIES: Readonly<
  Partial<Record<AnalysisErrorTag, AnalysisErrorProjection["category"]>>
> = {
  AnalysisInputError: "invalid_input",
  AnalysisCapabilityUnavailableError: "unsupported_provider",
  ProviderSelectionError: "unsupported_provider",
  EvidenceIntegrityError: "integrity_mismatch",
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
  const hopperMessage = hopperErrorUserMessage(error);
  if (hopperMessage !== undefined) return hopperMessage;
  if (error.userMessage !== undefined) return error.userMessage;
  const standardMessage = standardErrorMessage(error._tag);
  if (standardMessage !== undefined) return standardMessage;
  if (error instanceof ArtifactOperationError)
    return artifactMessage(error.reason);
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
    return "REA could not open that app or binary. Check that the path exists, is readable, and points to a supported file.";
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
  if (reason === "policy")
    return "Artifact integrity continuation is disabled by policy. Configure REA_ARTIFACT_INTEGRITY_CONTINUE_ENABLED=true and retry only if continuing after mismatches is approved.";
  if (reason === "unavailable")
    return "Artifact processing is unavailable for the current target or policy. Check artifact support and required approvals.";
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
  PermissionRequiredError: true,
  ReplayPlanStaleError: true,
} as const satisfies Readonly<Record<AnalysisErrorTag, true>>;

export const assertKnownAnalysisErrorTag = (tag: AnalysisErrorTag): void => {
  if (KNOWN_ERROR_TAGS[tag] !== true)
    throw new TypeError("Unknown analysis error tag");
};
