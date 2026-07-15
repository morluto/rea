import type { JsonValue } from "./jsonValue.js";
import type {
  MissingPermissionScope,
  PermissionRequest,
  PermissionScope,
} from "./permissionPolicy.js";
import {
  hopperStartupFailure,
  type HopperStartupFailureCode,
} from "./hopperStartupFailure.js";
export { hopperStartupFailure, type HopperStartupFailureCode };

/** Stable tags exposed by safe analysis-error projections. */
const ANALYSIS_ERROR_TAGS = [
  "AnalysisProtocolError",
  "AnalysisInputError",
  "AnalysisOutputError",
  "AnalysisCapabilityUnavailableError",
  "AnalysisCancelledError",
  "AnalysisTimeoutError",
  "ProviderSelectionError",
  "ProviderAdapterError",
  "BrowserObservationError",
  "ArtifactOperationError",
  "ProcessCaptureError",
  "EvidenceIntegrityError",
  "EvidenceLimitError",
  "EvidenceFileError",
  "InvestigationWorkspaceError",
  "UnknownRegistryError",
  "HopperTimeoutError",
  "HopperCancelledError",
  "HopperProtocolError",
  "HopperRemoteError",
  "HopperProcessError",
  "HopperStartError",
  "ConfigurationError",
  "NoBinaryOpenError",
  "BinaryTargetError",
  "PermissionRequiredError",
] as const;

/** Stable tag for an expected analysis failure. */
export type AnalysisErrorTag = (typeof ANALYSIS_ERROR_TAGS)[number];

/** Base class for expected analysis, provider, and session failures. */
export abstract class AnalysisError extends Error {
  abstract readonly _tag: AnalysisErrorTag;
  readonly userMessage: string | undefined = undefined;
  readonly userCategory: "permission_required" | "cancelled" | undefined =
    undefined;
  readonly cleanupIncomplete: boolean = false;
  readonly cleanupResources: readonly string[] = [];
}

/** Base class for failures produced specifically by the Hopper provider. */
export abstract class HopperError extends AnalysisError {}

/** Provider-neutral invalid analysis input or output at an application boundary. */
export class AnalysisProtocolError extends AnalysisError {
  readonly _tag = "AnalysisProtocolError";
}

/** Caller input failed provider-neutral application parsing. */
export class AnalysisInputError extends AnalysisError {
  readonly _tag = "AnalysisInputError";

  constructor(
    readonly operation: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid analysis input for ${operation}`, options);
  }
}

/** Provider output failed provider-neutral application parsing. */
export class AnalysisOutputError extends AnalysisError {
  readonly _tag = "AnalysisOutputError";

  constructor(
    readonly operation: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid analysis output for ${operation}: ${reason}`, options);
  }
}

/** Selected provider cannot execute a declared analysis operation. */
export class AnalysisCapabilityUnavailableError extends AnalysisError {
  readonly _tag = "AnalysisCapabilityUnavailableError";

  constructor(
    readonly providerId: string,
    readonly operation: string,
    readonly reason: string,
  ) {
    super(`Provider ${providerId} cannot execute ${operation}: ${reason}`);
  }
}

/** Caller cancellation won before provider-neutral work completed. */
export class AnalysisCancelledError extends AnalysisError {
  readonly _tag = "AnalysisCancelledError";

  constructor(readonly operation: string) {
    super(`Analysis operation was cancelled: ${operation}`);
  }
}

/** Provider-neutral operation exceeded its declared execution deadline. */
export class AnalysisTimeoutError extends AnalysisError {
  readonly _tag = "AnalysisTimeoutError";

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Analysis operation timed out after ${String(timeoutMs)}ms: ${operation}`,
    );
  }
}

/** Stable failure classes for target-bound deep-provider selection. */
export type ProviderSelectionFailureReason =
  | "unknown_provider"
  | "provider_unavailable"
  | "target_unsupported"
  | "ambiguous"
  | "invalid_options";

/** One actionable candidate rejection retained in caller diagnostics. */
export interface ProviderSelectionRejection {
  readonly providerId: string;
  readonly code: string;
  readonly reason: string;
  readonly diagnostics: Readonly<Record<string, JsonValue>>;
}

/** Complete typed context for one failed deep-provider selection. */
export interface ProviderSelectionErrorOptions {
  readonly operation?: string;
  readonly reason: ProviderSelectionFailureReason;
  readonly requestedProviderId: string;
  readonly candidateIds: readonly string[];
  readonly rejections?: readonly ProviderSelectionRejection[];
}

/** No configured provider can satisfy a requested operation or target binding. */
export class ProviderSelectionError extends AnalysisError {
  readonly _tag = "ProviderSelectionError";
  readonly operation: string;
  readonly reason: ProviderSelectionFailureReason;
  readonly requestedProviderId: string;
  readonly candidateIds: readonly string[];
  readonly rejections: readonly ProviderSelectionRejection[];
  override readonly userMessage: string;

  constructor(input: string | ProviderSelectionErrorOptions) {
    const legacy = typeof input === "string";
    const options: ProviderSelectionErrorOptions = legacy
      ? {
          operation: input,
          reason: "provider_unavailable",
          requestedProviderId: "auto",
          candidateIds: [],
        }
      : input;
    const operation = options.operation ?? "open_binary";
    super(
      legacy
        ? `No configured provider can execute ${operation}`
        : providerSelectionDiagnostic(options),
    );
    this.operation = operation;
    this.reason = options.reason;
    this.requestedProviderId = options.requestedProviderId;
    this.candidateIds = [...options.candidateIds];
    this.rejections = [...(options.rejections ?? [])].map((rejection) => ({
      ...rejection,
      diagnostics: structuredClone(rejection.diagnostics),
    }));
    this.userMessage = providerSelectionUserMessage(options);
  }
}

const providerSelectionDiagnostic = (
  options: ProviderSelectionErrorOptions,
): string => {
  const candidates =
    options.candidateIds.length === 0
      ? "none"
      : options.candidateIds.join(", ");
  return `Analysis provider selection failed (${options.reason}) for ${options.requestedProviderId}; candidates: ${candidates}`;
};

const providerSelectionUserMessage = (
  options: ProviderSelectionErrorOptions,
): string => {
  switch (options.reason) {
    case "ambiguous":
      return "Multiple analysis providers support this target. Choose one with provider_id, --provider, or REA_ANALYSIS_PROVIDER.";
    case "unknown_provider":
      return `The requested analysis provider is unknown. Choose one of: ${options.candidateIds.join(", ") || "no configured providers"}.`;
    case "provider_unavailable":
      return "The selected analysis provider is unavailable. Review the reported local diagnostics or run `rea doctor`, then retry.";
    case "target_unsupported":
      return "The selected analysis provider does not support this target. Choose another provider or open a supported extracted binary.";
    case "invalid_options":
      return "The analysis provider selection or open options are invalid. Correct them and try again.";
  }
};

/** A provider adapter failed outside its more precise typed variants. */
export interface ProviderAdapterErrorOptions extends ErrorOptions {
  readonly diagnostics?: Readonly<Record<string, JsonValue>>;
}

/** A provider adapter failed outside its more precise typed variants. */
export class ProviderAdapterError extends AnalysisError {
  readonly _tag = "ProviderAdapterError";
  readonly diagnostics: Readonly<Record<string, JsonValue>> | undefined;

  constructor(
    readonly providerId: string,
    readonly operation: string,
    options: ProviderAdapterErrorOptions = {},
  ) {
    super(`Provider ${providerId} adapter failed during ${operation}`, options);
    this.diagnostics =
      options.diagnostics === undefined
        ? undefined
        : structuredClone(options.diagnostics);
  }
}

/** Public browser and Electron operations that can fail at a CDP boundary. */
export type BrowserObservationOperation =
  | "list_browser_targets"
  | "inspect_web_page"
  | "analyze_web_bundle"
  | "observe_web_session"
  | "discover_webmcp_tools"
  | "compare_web_captures"
  | "capture_web_screenshot"
  | "compare_web_screenshots"
  | "list_electron_targets"
  | "inspect_electron_page";

/** A bounded passive browser observation failed at its CDP boundary. */
export class BrowserObservationError extends AnalysisError {
  readonly _tag = "BrowserObservationError";

  constructor(
    readonly operation: BrowserObservationOperation,
    readonly reason:
      | "endpoint_unreachable"
      | "invalid_endpoint_response"
      | "target_not_found"
      | "target_not_allowed"
      | "target_changed"
      | "protocol_error"
      | "disconnected"
      | "payload_limit",
    options?: ErrorOptions,
  ) {
    super(`Browser observation ${operation} failed: ${reason}`, options);
  }
}

/** Artifact inventory or extraction failed a typed safety boundary. */
export class ArtifactOperationError extends AnalysisError {
  readonly _tag = "ArtifactOperationError";

  constructor(
    readonly operation: "inventory_artifact" | "extract_artifact",
    readonly reason:
      | "cancelled"
      | "format"
      | "integrity"
      | "limit"
      | "path"
      | "unavailable"
      | "io",
    readonly artifactDetails?: Readonly<{
      logicalPath: string;
      declaredSha256: string | null;
      calculatedSha256: string | null;
      unpacked: boolean;
    }>,
  ) {
    super(
      artifactDetails === undefined
        ? `Artifact ${operation} failed: ${reason}`
        : `Artifact ${operation} failed: ${reason} at ${artifactDetails.logicalPath} (declared_sha256=${artifactDetails.declaredSha256 ?? "unavailable"}, calculated_sha256=${artifactDetails.calculatedSha256 ?? "unavailable"}, unpacked=${String(artifactDetails.unpacked)})`,
    );
  }
}

/** Evidence identity, schema, or bundle manifests failed integrity checks. */
export class EvidenceIntegrityError extends AnalysisError {
  readonly _tag = "EvidenceIntegrityError";
}

/** A bounded evidence ledger cannot accept more records or serialized bytes. */
export class EvidenceLimitError extends AnalysisError {
  readonly _tag = "EvidenceLimitError";

  constructor(
    readonly limit: "records" | "bytes",
    readonly maximum: number,
  ) {
    super(`Evidence ledger ${limit} limit exceeded (${String(maximum)})`);
  }
}

/** Evidence bundle filesystem access failed within the configured policy. */
export class EvidenceFileError extends AnalysisError {
  readonly _tag = "EvidenceFileError";

  constructor(
    readonly operation: "read" | "write",
    readonly reason:
      | "disabled"
      | "outside-root"
      | "not-file"
      | "too-large"
      | "exists"
      | "invalid-json"
      | "io",
    options?: ErrorOptions,
  ) {
    super(`Evidence bundle ${operation} failed: ${reason}`, options);
  }
}

/** Persistent investigation workspace access or CAS validation failed. */
export class InvestigationWorkspaceError extends AnalysisError {
  readonly _tag = "InvestigationWorkspaceError";

  constructor(
    readonly operation: "read" | "update",
    readonly reason:
      | "disabled"
      | "outside-root"
      | "not-file"
      | "too-large"
      | "invalid-json"
      | "integrity"
      | "locked"
      | "revision-conflict"
      | "name-conflict"
      | "io",
    options?: ErrorOptions,
  ) {
    super(`Investigation workspace ${operation} failed: ${reason}`, options);
  }
}

/** Residual-unknown mutation failed a lifecycle, reference, or CAS invariant. */
export class UnknownRegistryError extends AnalysisError {
  readonly _tag = "UnknownRegistryError";

  constructor(
    readonly reason:
      | "not-found"
      | "already-exists"
      | "revision-conflict"
      | "invalid-transition"
      | "integrity"
      | "limit",
    options?: ErrorOptions,
  ) {
    super(`Residual unknown registry mutation failed: ${reason}`, options);
  }
}

/** Hopper did not respond within the configured operation deadline. */
export class HopperTimeoutError extends HopperError {
  readonly _tag = "HopperTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Hopper did not respond within ${String(timeoutMs)}ms`);
  }
}

/** The caller cancelled a Hopper operation before it completed. */
export class HopperCancelledError extends HopperError {
  readonly _tag = "HopperCancelledError";

  constructor() {
    super("Hopper operation was cancelled");
  }
}

/** Hopper returned bytes or JSON that do not satisfy the NDJSON RPC contract. */
export class HopperProtocolError extends HopperError {
  readonly _tag = "HopperProtocolError";
}

export type HopperDiagnosticType =
  | "remote"
  | "authorization"
  | "invalid_request"
  | "bridge_exception";

/** Hopper's JSON-RPC endpoint returned an expected remote error response. */
export class HopperRemoteError extends HopperError {
  readonly _tag = "HopperRemoteError";

  constructor(
    readonly code: number,
    readonly safeMessage: string,
    readonly diagnosticType: HopperDiagnosticType = "remote",
  ) {
    super(`Hopper request failed (${String(code)}): ${safeMessage}`);
  }
}

/** The owned Hopper bridge stopped before its client was closed. */
export class HopperProcessError extends HopperError {
  readonly _tag = "HopperProcessError";
  readonly failureCode: HopperStartupFailureCode | undefined;
  override readonly userMessage: string | undefined;

  constructor(readonly exitCode: number | null) {
    super(`Hopper bridge stopped unexpectedly with code ${String(exitCode)}`);
    const failure = hopperStartupFailure(exitCode);
    this.failureCode = failure?.code;
    this.userMessage = failure?.message;
  }
}

/** Hopper or the repository bridge could not be started. */
export class HopperStartError extends HopperError {
  readonly _tag = "HopperStartError";

  constructor(options?: ErrorOptions) {
    super("Hopper application bridge could not be started", options);
  }
}

/** Runtime configuration could not be parsed safely. */
export class ConfigurationError extends AnalysisError {
  readonly _tag = "ConfigurationError";
}

/** No app or binary session exists for an analysis request. */
export class NoBinaryOpenError extends AnalysisError {
  readonly _tag = "NoBinaryOpenError";
  constructor() {
    super(
      "No app is open. Ask the user which app to investigate, then call open_binary with its local path.",
    );
  }
}

/** A supplied target path could not be safely opened as a supported app or binary. */
export class BinaryTargetError extends AnalysisError {
  readonly _tag = "BinaryTargetError";
  constructor(
    readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`Cannot open artifact: ${reason}`, options);
  }
}

export interface AnalysisErrorProjection
  extends Readonly<Record<string, JsonValue>> {
  readonly code:
    | "invalid_request"
    | "unreadable_output"
    | "capability_unavailable"
    | "provider_unavailable"
    | "provider_timeout"
    | "cancelled"
    | "artifact_integrity_mismatch"
    | "artifact_operation_failed"
    | "evidence_integrity_mismatch"
    | "truncated"
    | "permission_required"
    | "process_capture_failed"
    | "cleanup_incomplete"
    | "revision_conflict"
    | "outside_approved_root"
    | "configuration_invalid"
    | "target_unavailable"
    | "execution_failure";
  readonly category:
    | "invalid_input"
    | "permission_required"
    | "unsupported_provider"
    | "integrity_mismatch"
    | "truncated"
    | "cancelled"
    | "timeout"
    | "unavailable"
    | "execution_failure";
  readonly message: string;
  readonly retryable: boolean;
  readonly remediation: Readonly<{
    action: string;
    restart_required: boolean;
    elicitation_supported?: boolean;
  }>;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

/** Exact denied authority used by both CLI and MCP remediation. */
export class PermissionRequiredError extends AnalysisError {
  readonly _tag = "PermissionRequiredError" as const;

  constructor(
    readonly requested: PermissionRequest,
    readonly missing: MissingPermissionScope,
    readonly ceiling: PermissionScope | null,
    readonly elicitationSupported: boolean,
    readonly restartRequired: boolean,
  ) {
    super(`Permission required for ${requested.capability}`);
  }
}

/** Project expected failures into exhaustive, secret-safe caller fields. */
export const projectAnalysisError = (
  error: AnalysisError,
): AnalysisErrorProjection => {
  assertKnownTag(error._tag);
  const code = errorCode(error);
  const details = errorDetails(error);
  return {
    code,
    category: errorCategory(error),
    message: userMessage(error),
    retryable: RETRYABLE_CODES.has(code),
    remediation: {
      action: remediationAction(error),
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
  if (error instanceof PermissionRequiredError) return "permission_required";
  if (
    error instanceof ProviderSelectionError &&
    error.reason === "provider_unavailable"
  )
    return "provider_unavailable";
  if (error instanceof BrowserObservationError) {
    if (error.reason === "payload_limit") return "truncated";
    if (
      error.reason === "target_not_found" ||
      error.reason === "target_not_allowed" ||
      error.reason === "target_changed"
    )
      return "target_unavailable";
    if (
      error.reason === "endpoint_unreachable" ||
      error.reason === "disconnected"
    )
      return "provider_unavailable";
    return "unreadable_output";
  }
  if (error instanceof ArtifactOperationError)
    return error.reason === "integrity" && error.artifactDetails !== undefined
      ? "artifact_integrity_mismatch"
      : error.reason === "limit"
        ? "truncated"
        : error.reason === "cancelled"
          ? "cancelled"
          : "artifact_operation_failed";
  if (error instanceof EvidenceFileError)
    return error.reason === "outside-root"
      ? "outside_approved_root"
      : error.reason === "too-large"
        ? "truncated"
        : error.reason === "disabled"
          ? "capability_unavailable"
          : "execution_failure";
  if (error instanceof InvestigationWorkspaceError) {
    if (
      error.reason === "revision-conflict" ||
      error.reason === "name-conflict"
    )
      return "revision_conflict";
    if (error.reason === "too-large") return "truncated";
    if (error.reason === "disabled") return "capability_unavailable";
    if (error.reason === "outside-root") return "outside_approved_root";
    if (error.reason === "integrity" || error.reason === "invalid-json")
      return "evidence_integrity_mismatch";
    return "execution_failure";
  }
  if (error instanceof UnknownRegistryError)
    return error.reason === "revision-conflict" ||
      error.reason === "already-exists"
      ? "revision_conflict"
      : error.reason === "limit"
        ? "truncated"
        : error.reason === "integrity"
          ? "evidence_integrity_mismatch"
          : "execution_failure";
  if (error._tag === "ProcessCaptureError")
    return error.cleanupIncomplete
      ? "cleanup_incomplete"
      : error.userCategory === "cancelled"
        ? "cancelled"
        : error.userCategory === "permission_required"
          ? "permission_required"
          : "process_capture_failed";
  switch (error._tag) {
    case "AnalysisProtocolError":
    case "AnalysisOutputError":
    case "HopperProtocolError":
      return "unreadable_output";
    case "AnalysisInputError":
      return "invalid_request";
    case "AnalysisCapabilityUnavailableError":
    case "ProviderSelectionError":
      return "capability_unavailable";
    case "AnalysisCancelledError":
    case "HopperCancelledError":
      return "cancelled";
    case "AnalysisTimeoutError":
    case "HopperTimeoutError":
      return "provider_timeout";
    case "HopperProcessError":
    case "HopperStartError":
      return "provider_unavailable";
    case "ConfigurationError":
      return "configuration_invalid";
    case "NoBinaryOpenError":
    case "BinaryTargetError":
      return "target_unavailable";
    case "EvidenceIntegrityError":
      return "evidence_integrity_mismatch";
    case "EvidenceLimitError":
      return "truncated";
    case "ProviderAdapterError":
    case "HopperRemoteError":
      return "execution_failure";
    case "BrowserObservationError":
      throw new TypeError("Unhandled specialized browser error");
    case "ArtifactOperationError":
    case "EvidenceFileError":
    case "InvestigationWorkspaceError":
    case "UnknownRegistryError":
    case "PermissionRequiredError":
      throw new TypeError("Unhandled specialized analysis error");
  }
};

const errorDetails = (
  error: AnalysisError,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (error instanceof PermissionRequiredError)
    return {
      capability: error.requested.capability,
      requested: scopeDetails(error.requested),
      missing: missingScopeDetails(error.missing),
      ceiling: error.ceiling === null ? null : scopeDetails(error.ceiling),
    };
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
  if (error instanceof AnalysisCancelledError)
    return { operation: error.operation, cleanup: "complete" };
  if (error instanceof HopperCancelledError)
    return { operation: "hopper", cleanup: "complete" };
  if (error instanceof AnalysisTimeoutError)
    return { operation: error.operation, timeout_ms: error.timeoutMs };
  if (error instanceof HopperTimeoutError)
    return { operation: "hopper", timeout_ms: error.timeoutMs };
  if (error instanceof EvidenceLimitError)
    return { limit: error.limit, maximum: error.maximum, truncated: true };
  if (error instanceof InvestigationWorkspaceError)
    return { operation: error.operation, reason: error.reason };
  if (error instanceof UnknownRegistryError) return { reason: error.reason };
  if (error instanceof EvidenceFileError)
    return { operation: error.operation, reason: error.reason };
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
    return { failure_code: error.failureCode, exit_code: error.exitCode };
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
  "provider_timeout",
  "cancelled",
  "revision_conflict",
  "provider_unavailable",
]);

const remediationAction = (error: AnalysisError): string => {
  if (error instanceof PermissionRequiredError)
    return error.elicitationSupported
      ? "Approve the exact missing scope, then retry the operation."
      : "Add the exact missing scope beneath the administrator ceiling, then retry.";
  return userMessage(error);
};

const errorCategory = (
  error: AnalysisError,
): AnalysisErrorProjection["category"] => {
  if (error instanceof PermissionRequiredError) return "permission_required";
  if (
    error instanceof ProviderSelectionError &&
    error.reason === "provider_unavailable"
  )
    return "unavailable";
  if (error._tag === "ProcessCaptureError")
    return error.userCategory ?? "execution_failure";
  if (error instanceof BrowserObservationError) {
    if (error.reason === "payload_limit") return "truncated";
    if (
      error.reason === "target_not_found" ||
      error.reason === "target_not_allowed" ||
      error.reason === "target_changed" ||
      error.reason === "endpoint_unreachable" ||
      error.reason === "disconnected"
    )
      return "unavailable";
  }
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

const userMessage = (error: AnalysisError): string => {
  if (error instanceof PermissionRequiredError)
    return "This operation needs additional local permission. Review the requested scope and remediation.";
  if (error instanceof AnalysisInputError)
    return "Analysis input is invalid. Check the arguments and try again.";
  if (error.userMessage !== undefined) return error.userMessage;
  if (UNREADABLE_OUTPUT_TAGS.has(error._tag))
    return "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.";
  if (UNSUPPORTED_PROVIDER_TAGS.has(error._tag))
    return "This analysis is unavailable for the current target. Choose another analysis or target.";
  if (CANCELLED_TAGS.has(error._tag))
    return "Analysis was cancelled. Start it again when ready.";
  if (TIMEOUT_TAGS.has(error._tag))
    return "Analysis took too long. Try a smaller request, then run `rea doctor` if it continues.";
  if (ADAPTER_FAILURE_TAGS.has(error._tag))
    return "Analysis could not complete. Retry once; if it continues, run `rea doctor`.";
  if (START_FAILURE_TAGS.has(error._tag))
    return "Analysis could not start or stopped unexpectedly. Run `rea doctor`, then try again.";
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
} as const satisfies Readonly<Record<AnalysisErrorTag, true>>;

const assertKnownTag = (tag: AnalysisErrorTag): void => {
  if (KNOWN_ERROR_TAGS[tag] !== true)
    throw new TypeError("Unknown analysis error tag");
};
