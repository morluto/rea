import { jsonValueSchema, type JsonValue } from "./jsonValue.js";

import {
  analysisErrorCategory,
  analysisErrorRemediationAction,
  analysisErrorUserMessage,
  assertKnownAnalysisErrorTag,
} from "./analysisErrorPresentation.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisUnsupportedTargetError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
  AnalysisResourceConstraintError,
} from "./analysisErrorCore.js";
import { ArtifactOperationError } from "./artifactOperationError.js";
import { BinaryTargetError } from "./configurationErrors.js";
import { BrowserObservationError } from "./browserObservationError.js";
import { EvidenceFileError, EvidenceReferenceError } from "./evidenceErrors.js";
import {
  HopperCancelledError,
  HopperProcessError,
  HopperRemoteError,
  HopperTimeoutError,
} from "./hopperErrors.js";
import { ProviderAdapterError } from "./providerAdapterError.js";
import { ProviderSelectionError } from "./providerSelectionError.js";
import { UnknownRegistryError } from "./unknownRegistryError.js";
import {
  type AnalysisError,
  type AnalysisErrorTag,
} from "./analysisErrorBase.js";

/** Project expected failures into exhaustive, secret-safe caller fields. */
export const projectAnalysisError = (
  error: AnalysisError,
): AnalysisErrorProjection => {
  assertKnownAnalysisErrorTag(error._tag);
  const code = errorCode(error);
  const primaryDetails = errorDetails(error);
  const details =
    error.capturedOutput === undefined
      ? primaryDetails
      : { ...primaryDetails, captured_output: { ...error.capturedOutput } };
  return {
    code,
    category: analysisErrorCategory(error),
    message: analysisErrorUserMessage(error),
    retryable: RETRYABLE_CODES.has(code),
    remediation: {
      action: analysisErrorRemediationAction(error),
    },
    ...(details === undefined ? {} : { details }),
  };
};

const errorCode = (error: AnalysisError): AnalysisErrorProjection["code"] => {
  if (error.cleanupIncomplete) return "cleanup_incomplete";
  if (error instanceof ProviderSelectionError)
    return error.reason === "provider_unavailable"
      ? "provider_unavailable"
      : "capability_unavailable";
  if (error instanceof BrowserObservationError)
    return browserErrorCode(error.reason);
  if (error instanceof ArtifactOperationError)
    return artifactOperationCode(error);
  if (error instanceof EvidenceFileError) return evidenceFileCode(error.reason);
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
): AnalysisErrorProjection["code"] =>
  reason === "invalid-json"
    ? "evidence_integrity_mismatch"
    : "execution_failure";

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
  return "process_capture_failed";
};

type SpecializedErrorTag =
  | "ArtifactOperationError"
  | "BrowserObservationError"
  | "EvidenceFileError"
  | "ProcessCaptureError"
  | "ProviderSelectionError"
  | "UnknownRegistryError";

const STATIC_ERROR_CODES = {
  AnalysisProtocolError: "unreadable_output",
  AnalysisOutputError: "unreadable_output",
  HopperProtocolError: "unreadable_output",
  AnalysisInputError: "invalid_request",
  AnalysisAccessDeniedError: "access_denied",
  AnalysisArtifactChangedError: "artifact_changed",
  AnalysisCapabilityUnavailableError: "capability_unavailable",
  AnalysisUnsupportedTargetError: "unsupported_target",
  AnalysisCancelledError: "cancelled",
  HopperCancelledError: "cancelled",
  AnalysisTimeoutError: "provider_timeout",
  AnalysisResourceConstraintError: "resource_constraint",
  HopperTimeoutError: "provider_timeout",
  HopperProcessError: "provider_unavailable",
  HopperStartError: "provider_unavailable",
  ConfigurationError: "configuration_invalid",
  NoBinaryOpenError: "target_unavailable",
  BinaryTargetError: "target_unavailable",
  EvidenceIntegrityError: "evidence_integrity_mismatch",
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
    case "ProcessCaptureError":
    case "ProviderSelectionError":
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
  if (error instanceof AnalysisUnsupportedTargetError)
    return {
      operation: error.operation,
      path: error.path,
      reason: error.reason,
    };
  if (error instanceof AnalysisResourceConstraintError)
    return {
      operation: error.operation,
      resource: error.resource,
      reason: error.reason,
      reported_limits: error.reportedLimits,
    };
  if (error instanceof AnalysisArtifactChangedError)
    return {
      operation: error.operation,
      path: error.path,
      reason: error.reason,
      boundary: "stable-artifact-read",
    };
  if (error instanceof AnalysisAccessDeniedError)
    return {
      operation: error.operation,
      path: error.path,
      system_code: error.systemCode,
      boundary: "filesystem-read",
    };
  if (error instanceof AnalysisOutputError)
    return { operation: error.operation, reason: error.reason };
  if (error instanceof AnalysisInputError && error.issues.length > 0)
    return {
      operation: error.operation,
      issues: error.issues.map((issue) => ({
        path: [...issue.path],
        reason: issue.reason,
        ...(issue.message === undefined ? {} : { message: issue.message }),
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
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  if (error instanceof UnknownRegistryError) return { reason: error.reason };
  if (error instanceof EvidenceFileError)
    return { operation: error.operation, reason: error.reason };
  return undefined;
};

const providerErrorDetails = (
  error: AnalysisError,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (error instanceof AnalysisCapabilityUnavailableError)
    return {
      provider_id: error.providerId,
      operation: error.operation,
      reason: error.reason,
    };
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
      ...(error.cleanupIncomplete
        ? {
            cleanup: "incomplete",
            resources: [...error.cleanupResources],
          }
        : {}),
      ...(error.diagnostics === undefined
        ? {}
        : { diagnostics: error.diagnostics }),
    };
  if (error instanceof BrowserObservationError) {
    const primaryReason = primaryBrowserFailureReason(error);
    return {
      operation: error.operation,
      reason: error.reason,
      ...(error.cleanupIncomplete
        ? {
            cleanup: "incomplete",
            resources: [...error.cleanupResources],
            ...(primaryReason === undefined
              ? {}
              : { primary_reason: primaryReason }),
          }
        : {}),
    };
  }
  if (error instanceof HopperRemoteError)
    return {
      stage: "analysis",
      provider_code: error.code,
      diagnostic_type: error.diagnosticType,
      ...(error.operation === undefined ? {} : { operation: error.operation }),
      ...(error.requestId === undefined ? {} : { request_id: error.requestId }),
    };
  if (error instanceof HopperProcessError)
    return {
      exit_code: error.exitCode,
      stage: error.operation === undefined ? "connection" : "analysis",
      ...(error.failureCode === undefined
        ? {}
        : { failure_code: error.failureCode }),
      ...(error.operation === undefined ? {} : { operation: error.operation }),
      ...(error.requestId === undefined ? {} : { request_id: error.requestId }),
      ...(error.diagnostic === undefined
        ? {}
        : { diagnostics: { ...error.diagnostic } }),
    };
  return undefined;
};

const primaryBrowserFailureReason = (
  error: BrowserObservationError,
): string | undefined => {
  if (!(error.cause instanceof AggregateError)) return undefined;
  const primary = error.cause.errors[0];
  if (primary instanceof BrowserObservationError) return primary.reason;
  if (primary instanceof AnalysisCancelledError) return "cancelled";
  if (primary instanceof AnalysisTimeoutError) return "timeout";
  if (typeof primary === "object" && primary !== null && "_tag" in primary)
    return typeof primary._tag === "string"
      ? primary._tag
      : "execution_failure";
  return "execution_failure";
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
    return {
      stage: error.operation === undefined ? "startup" : "analysis",
      timeout_ms: error.timeoutMs,
      provider_state: error.providerState,
      ...(error.operation === undefined ? {} : { operation: error.operation }),
      ...(error.requestId === undefined ? {} : { request_id: error.requestId }),
    };
  if (error._tag === "ProcessCaptureError" && error.cleanupIncomplete)
    return {
      cleanup: "incomplete",
      resources: [...error.cleanupResources],
      ...(error.cleanupReport === undefined
        ? {}
        : { cleanup_report: jsonValueSchema.parse(error.cleanupReport) }),
      ...(error.executionFailure === undefined
        ? {}
        : { execution_failure: error.executionFailure }),
      ...(error.partialObservation === undefined
        ? {}
        : {
            partial_observation: jsonValueSchema.parse(
              error.partialObservation,
            ),
          }),
    };
  if (
    error._tag === "ProcessCaptureError" &&
    error.userCategory === "cancelled"
  )
    return { operation: "process_capture", cleanup: "complete" };
  if (
    error._tag === "ProcessCaptureError" &&
    error.executionFailure !== undefined
  )
    return { execution_failure: error.executionFailure };
  if (error instanceof BinaryTargetError)
    return {
      path: error.path,
      reason: error.reason,
      ...(error.constraint === undefined
        ? {}
        : { constraint: error.constraint }),
    };
  return undefined;
};

const RETRYABLE_CODES: ReadonlySet<AnalysisErrorProjection["code"]> = new Set([
  "artifact_changed",
  "invalid_request",
  "provider_timeout",
  "cancelled",
  "revision_conflict",
  "provider_unavailable",
]);

export interface AnalysisErrorProjection extends Readonly<
  Record<string, JsonValue>
> {
  readonly code:
    | "invalid_request"
    | "access_denied"
    | "artifact_changed"
    | "unreadable_output"
    | "capability_unavailable"
    | "unsupported_target"
    | "provider_unavailable"
    | "provider_timeout"
    | "resource_constraint"
    | "cancelled"
    | "artifact_integrity_mismatch"
    | "artifact_operation_failed"
    | "evidence_integrity_mismatch"
    | "truncated"
    | "process_capture_failed"
    | "cleanup_incomplete"
    | "revision_conflict"
    | "configuration_invalid"
    | "target_unavailable"
    | "execution_failure";
  readonly category:
    | "invalid_input"
    | "unsupported_provider"
    | "unsupported_target"
    | "integrity_mismatch"
    | "truncated"
    | "cancelled"
    | "timeout"
    | "resource_constraint"
    | "unavailable"
    | "execution_failure";
  readonly message: string;
  readonly retryable: boolean;
  readonly remediation: Readonly<{
    action: string;
  }>;
  readonly details?: Readonly<Record<string, JsonValue>>;
}
