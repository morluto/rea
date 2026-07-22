import type { JsonValue } from "./jsonValue.js";
import type {
  MissingPermissionScope,
  PermissionScope,
} from "./permissionPolicy.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisTimeoutError,
  ArtifactOperationError,
  BinaryTargetError,
  BrowserObservationError,
  EvidenceFileError,
  EvidenceLimitError,
  EvidenceReferenceError,
  HopperCancelledError,
  HopperProcessError,
  HopperRemoteError,
  HopperTimeoutError,
  InvestigationWorkspaceError,
  PermissionRequiredError,
  ProviderAdapterError,
  ProviderSelectionError,
  ReplayPlanStaleError,
  UnknownRegistryError,
  type AnalysisError,
  type AnalysisErrorProjection,
  type AnalysisErrorTag,
} from "./errors.js";
import {
  analysisErrorCategory,
  analysisErrorRemediationAction,
  analysisErrorUserMessage,
  assertKnownAnalysisErrorTag,
} from "./analysisErrorPresentation.js";

/** Project expected failures into exhaustive, secret-safe caller fields. */
export const projectAnalysisError = (
  error: AnalysisError,
): AnalysisErrorProjection => {
  assertKnownAnalysisErrorTag(error._tag);
  const code = errorCode(error);
  const details = errorDetails(error);
  return {
    code,
    category: analysisErrorCategory(error),
    message: analysisErrorUserMessage(error),
    retryable: RETRYABLE_CODES.has(code),
    remediation: {
      action: analysisErrorRemediationAction(error),
      restart_required:
        error instanceof PermissionRequiredError && error.restartRequired,
      ...(error instanceof PermissionRequiredError
        ? { elicitation_supported: error.elicitationSupported }
        : {}),
    },
    ...(details === undefined ? {} : { details }),
  };
};

const errorCode = (error: AnalysisError): AnalysisErrorProjection["code"] => {
  if (error instanceof ReplayPlanStaleError) return "plan_stale";
  if (error instanceof PermissionRequiredError) return "permission_required";
  if (error instanceof ProviderSelectionError)
    return error.reason === "provider_unavailable"
      ? "provider_unavailable"
      : "capability_unavailable";
  if (error instanceof BrowserObservationError)
    return browserErrorCode(error.reason);
  if (error instanceof ArtifactOperationError)
    return artifactOperationCode(error);
  if (error instanceof EvidenceFileError) return evidenceFileCode(error.reason);
  if (error instanceof InvestigationWorkspaceError)
    return investigationWorkspaceCode(error.reason);
  if (error instanceof UnknownRegistryError)
    return unknownRegistryCode(error.reason);
  if (error._tag === "ProcessCaptureError") return processCaptureCode(error);
  return staticErrorCode(error._tag);
};

const browserErrorCode = (
  reason: BrowserObservationError["reason"],
): AnalysisErrorProjection["code"] => {
  if (reason === "payload_limit") return "truncated";
  if (
    reason === "target_not_found" ||
    reason === "target_not_allowed" ||
    reason === "target_changed"
  )
    return "target_unavailable";
  if (reason === "endpoint_unreachable" || reason === "disconnected")
    return "provider_unavailable";
  return "unreadable_output";
};

const artifactOperationCode = (
  error: ArtifactOperationError,
): AnalysisErrorProjection["code"] => {
  if (error.reason === "integrity" && error.artifactDetails !== undefined)
    return "artifact_integrity_mismatch";
  if (error.reason === "limit") return "truncated";
  if (error.reason === "cancelled") return "cancelled";
  return "artifact_operation_failed";
};

const evidenceFileCode = (
  reason: EvidenceFileError["reason"],
): AnalysisErrorProjection["code"] => {
  if (reason === "outside-root") return "outside_approved_root";
  if (reason === "too-large") return "truncated";
  if (reason === "disabled") return "capability_unavailable";
  return "execution_failure";
};

const investigationWorkspaceCode = (
  reason: InvestigationWorkspaceError["reason"],
): AnalysisErrorProjection["code"] => {
  if (reason === "revision-conflict" || reason === "name-conflict")
    return "revision_conflict";
  if (reason === "too-large") return "truncated";
  if (reason === "disabled") return "capability_unavailable";
  if (reason === "outside-root") return "outside_approved_root";
  if (reason === "integrity" || reason === "invalid-json")
    return "evidence_integrity_mismatch";
  return "execution_failure";
};

const unknownRegistryCode = (
  reason: UnknownRegistryError["reason"],
): AnalysisErrorProjection["code"] => {
  if (reason === "revision-conflict" || reason === "already-exists")
    return "revision_conflict";
  if (reason === "limit") return "truncated";
  if (reason === "integrity") return "evidence_integrity_mismatch";
  return "execution_failure";
};

const processCaptureCode = (
  error: AnalysisError,
): AnalysisErrorProjection["code"] => {
  if (error.cleanupIncomplete) return "cleanup_incomplete";
  if (error.userCategory === "cancelled") return "cancelled";
  if (error.userCategory === "permission_required")
    return "permission_required";
  return "process_capture_failed";
};

type SpecializedErrorTag =
  | "ArtifactOperationError"
  | "BrowserObservationError"
  | "EvidenceFileError"
  | "InvestigationWorkspaceError"
  | "PermissionRequiredError"
  | "ProcessCaptureError"
  | "ProviderSelectionError"
  | "ReplayPlanStaleError"
  | "UnknownRegistryError";

const STATIC_ERROR_CODES = {
  AnalysisProtocolError: "unreadable_output",
  AnalysisOutputError: "unreadable_output",
  HopperProtocolError: "unreadable_output",
  AnalysisInputError: "invalid_request",
  AnalysisCapabilityUnavailableError: "capability_unavailable",
  AnalysisCancelledError: "cancelled",
  HopperCancelledError: "cancelled",
  AnalysisTimeoutError: "provider_timeout",
  HopperTimeoutError: "provider_timeout",
  HopperProcessError: "provider_unavailable",
  HopperStartError: "provider_unavailable",
  ConfigurationError: "configuration_invalid",
  NoBinaryOpenError: "target_unavailable",
  BinaryTargetError: "target_unavailable",
  EvidenceIntegrityError: "evidence_integrity_mismatch",
  EvidenceLimitError: "truncated",
  ProviderAdapterError: "execution_failure",
  HopperRemoteError: "execution_failure",
} as const satisfies Readonly<
  Record<
    Exclude<AnalysisErrorTag, SpecializedErrorTag>,
    AnalysisErrorProjection["code"]
  >
>;

const staticErrorCode = (
  tag: AnalysisErrorTag,
): AnalysisErrorProjection["code"] => {
  switch (tag) {
    case "ArtifactOperationError":
    case "BrowserObservationError":
    case "EvidenceFileError":
    case "InvestigationWorkspaceError":
    case "PermissionRequiredError":
    case "ProcessCaptureError":
    case "ProviderSelectionError":
    case "ReplayPlanStaleError":
    case "UnknownRegistryError":
      throw new TypeError(`Unhandled specialized analysis error: ${tag}`);
    default:
      return STATIC_ERROR_CODES[tag];
  }
};

const errorDetails = (
  error: AnalysisError,
): Readonly<Record<string, JsonValue>> | undefined =>
  requestErrorDetails(error) ??
  artifactStateErrorDetails(error) ??
  providerErrorDetails(error) ??
  lifecycleErrorDetails(error);

const requestErrorDetails = (
  error: AnalysisError,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (error instanceof AnalysisInputError && error.issues.length > 0)
    return {
      operation: error.operation,
      issues: error.issues.map((issue) => ({
        path: [...issue.path],
        reason: issue.reason,
        ...(issue.expected === undefined ? {} : { expected: issue.expected }),
        ...(issue.minimum === undefined ? {} : { minimum: issue.minimum }),
        ...(issue.maximum === undefined ? {} : { maximum: issue.maximum }),
      })),
    };
  if (error instanceof EvidenceReferenceError)
    return {
      evidence_id: error.evidenceId,
      reason: error.reason,
      expected: error.expected,
      actual: error.actual,
    };
  if (error instanceof ReplayPlanStaleError)
    return {
      approved_plan_digest: error.approvedDigest,
      actual_plan_digest: error.actualDigest,
      application_code_admitted: false,
    };
  if (error instanceof PermissionRequiredError)
    return {
      capability: error.requested.capability,
      requested: scopeDetails(error.requested),
      missing: missingScopeDetails(error.missing),
      ceiling: error.ceiling === null ? null : scopeDetails(error.ceiling),
    };
  return undefined;
};

const artifactStateErrorDetails = (
  error: AnalysisError,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (error instanceof ArtifactOperationError && error.artifactDetails)
    return {
      logical_path: error.artifactDetails.logicalPath,
      declared_sha256: error.artifactDetails.declaredSha256,
      calculated_sha256: error.artifactDetails.calculatedSha256,
      unpacked: error.artifactDetails.unpacked,
    };
  if (error instanceof ArtifactOperationError)
    return {
      operation: error.operation,
      reason: error.reason,
      ...(error.reason === "limit" ? { truncated: true } : {}),
    };
  if (error instanceof EvidenceLimitError)
    return { limit: error.limit, maximum: error.maximum, truncated: true };
  if (error instanceof InvestigationWorkspaceError)
    return { operation: error.operation, reason: error.reason };
  if (error instanceof UnknownRegistryError) return { reason: error.reason };
  if (error instanceof EvidenceFileError)
    return { operation: error.operation, reason: error.reason };
  return undefined;
};

const providerErrorDetails = (
  error: AnalysisError,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (error instanceof AnalysisCapabilityUnavailableError)
    return { provider_id: error.providerId, operation: error.operation };
  if (error instanceof ProviderSelectionError)
    return {
      operation: error.operation,
      selection_reason: error.reason,
      requested_provider_id: error.requestedProviderId,
      candidate_ids: [...error.candidateIds],
      rejections: error.rejections.map((rejection) => ({
        provider_id: rejection.providerId,
        code: rejection.code,
        reason: rejection.reason,
        diagnostics: rejection.diagnostics,
      })),
    };
  if (error instanceof ProviderAdapterError)
    return {
      provider_id: error.providerId,
      operation: error.operation,
      ...(error.diagnostics === undefined
        ? {}
        : { diagnostics: error.diagnostics }),
    };
  if (error instanceof BrowserObservationError)
    return { operation: error.operation, reason: error.reason };
  if (error instanceof HopperRemoteError)
    return { provider_code: error.code, diagnostic_type: error.diagnosticType };
  if (error instanceof HopperProcessError && error.failureCode !== undefined)
    return {
      failure_code: error.failureCode,
      exit_code: error.exitCode,
      ...(error.diagnostic === undefined
        ? {}
        : { diagnostics: { ...error.diagnostic } }),
    };
  return undefined;
};

const lifecycleErrorDetails = (
  error: AnalysisError,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (error instanceof AnalysisCancelledError)
    return { operation: error.operation, cleanup: "complete" };
  if (error instanceof HopperCancelledError)
    return { operation: "hopper", cleanup: "complete" };
  if (error instanceof AnalysisTimeoutError)
    return { operation: error.operation, timeout_ms: error.timeoutMs };
  if (error instanceof HopperTimeoutError)
    return { operation: "hopper", timeout_ms: error.timeoutMs };
  if (error._tag === "ProcessCaptureError" && error.cleanupIncomplete)
    return {
      cleanup: "incomplete",
      resources: [...error.cleanupResources],
    };
  if (
    error._tag === "ProcessCaptureError" &&
    error.userCategory === "cancelled"
  )
    return { operation: "process_capture", cleanup: "complete" };
  if (error instanceof BinaryTargetError) return { path: error.path };
  return undefined;
};

const scopeDetails = (
  scope: PermissionScope,
): Readonly<Record<string, JsonValue>> => ({
  capability: scope.capability,
  roots: [...scope.roots],
  executables: [...scope.executables],
  environment_names: [...scope.environment_names],
  ...(scope.origins === undefined ? {} : { origins: [...scope.origins] }),
  network: scope.network,
  mount: scope.mount,
});

const missingScopeDetails = (
  scope: MissingPermissionScope,
): Readonly<Record<string, JsonValue>> => ({
  ...(scope.roots === undefined ? {} : { roots: [...scope.roots] }),
  ...(scope.executables === undefined
    ? {}
    : { executables: [...scope.executables] }),
  ...(scope.environment_names === undefined
    ? {}
    : { environment_names: [...scope.environment_names] }),
  ...(scope.origins === undefined ? {} : { origins: [...scope.origins] }),
  ...(scope.network === undefined ? {} : { network: scope.network }),
  ...(scope.mount === undefined ? {} : { mount: scope.mount }),
});

const RETRYABLE_CODES: ReadonlySet<AnalysisErrorProjection["code"]> = new Set([
  "invalid_request",
  "provider_timeout",
  "cancelled",
  "revision_conflict",
  "provider_unavailable",
]);
