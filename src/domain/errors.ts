import type { JsonValue } from "./jsonValue.js";
import type {
  MissingPermissionScope,
  PermissionRequest,
  PermissionScope,
} from "./permissionPolicy.js";
import {
  hopperStartupFailure,
  type HopperStartupDiagnostic,
  type HopperStartupFailureCode,
} from "./hopperStartupFailure.js";
export {
  hopperStartupFailure,
  type HopperStartupDiagnostic,
  type HopperStartupFailureCode,
};
export { projectAnalysisError } from "./analysisErrorProjection.js";

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
  "ReplayPlanStaleError",
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
    readonly issues: readonly AnalysisInputIssue[] = [],
  ) {
    super(`Invalid analysis input for ${operation}`, options);
  }
}

/** Secret-safe correction metadata for one rejected caller argument. */
export interface AnalysisInputIssue {
  readonly path: readonly (string | number)[];
  readonly reason:
    | "unknown_argument"
    | "missing_argument"
    | "invalid_type"
    | "out_of_range"
    | "invalid_value"
    | "invalid_format";
  readonly expected?: JsonValue;
  readonly minimum?: number;
  readonly maximum?: number;
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
    readonly operation:
      | "inventory_artifact"
      | "extract_artifact"
      | "analyze_javascript_application",
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

/** A session Evidence reference is missing or has the wrong semantic identity. */
export class EvidenceReferenceError extends EvidenceIntegrityError {
  constructor(
    readonly evidenceId: string,
    readonly reason: "missing" | "wrong_operation" | "wrong_predicate",
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super(`Evidence reference ${reason}: ${evidenceId}`);
  }
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

  constructor(
    readonly exitCode: number | null,
    readonly diagnostic?: HopperStartupDiagnostic,
  ) {
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
    | "execution_failure"
    | "plan_stale";
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
  readonly requested: PermissionRequest;
  readonly missing: MissingPermissionScope;
  readonly ceiling: PermissionScope | null;
  readonly elicitationSupported: boolean;
  readonly restartRequired: boolean;

  constructor(
    ...args: readonly [
      requested: PermissionRequest,
      missing: MissingPermissionScope,
      ceiling: PermissionScope | null,
      elicitationSupported: boolean,
      restartRequired: boolean,
    ]
  ) {
    const [requested, missing, ceiling, elicitationSupported, restartRequired] =
      args;
    super(`Permission required for ${requested.capability}`);
    this.requested = requested;
    this.missing = missing;
    this.ceiling = ceiling;
    this.elicitationSupported = elicitationSupported;
    this.restartRequired = restartRequired;
  }
}

/** Approved replay commitment no longer matches the immediately rebuilt plan. */
export class ReplayPlanStaleError extends AnalysisError {
  readonly _tag = "ReplayPlanStaleError" as const;

  constructor(
    readonly approvedDigest: string,
    readonly actualDigest: string,
  ) {
    super("Controlled replay plan changed before execution");
  }
}
