import type { JsonValue } from "./jsonValue.js";

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
  "ArtifactOperationError",
  "ProcessCaptureError",
  "EvidenceIntegrityError",
  "EvidenceLimitError",
  "EvidenceFileError",
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
] as const;

/** Stable tag for an expected analysis failure. */
export type AnalysisErrorTag = (typeof ANALYSIS_ERROR_TAGS)[number];

/** Base class for expected analysis, provider, and session failures. */
export abstract class AnalysisError extends Error {
  abstract readonly _tag: AnalysisErrorTag;
  readonly userMessage: string | undefined = undefined;
  readonly userCategory: "permission_required" | "cancelled" | undefined =
    undefined;
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

/** No configured provider can satisfy a requested operation. */
export class ProviderSelectionError extends AnalysisError {
  readonly _tag = "ProviderSelectionError";

  constructor(readonly operation: string) {
    super(`No configured provider can execute ${operation}`);
  }
}

/** A provider adapter failed outside its more precise typed variants. */
export class ProviderAdapterError extends AnalysisError {
  readonly _tag = "ProviderAdapterError";

  constructor(
    readonly providerId: string,
    readonly operation: string,
    options?: ErrorOptions,
  ) {
    super(`Provider ${providerId} adapter failed during ${operation}`, options);
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

  constructor(readonly exitCode: number | null) {
    super(`Hopper bridge stopped unexpectedly with code ${String(exitCode)}`);
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
}

/** Project expected failures into exhaustive, secret-safe caller fields. */
export const projectAnalysisError = (
  error: AnalysisError,
): AnalysisErrorProjection => {
  assertKnownTag(error._tag);
  return {
    category: errorCategory(error),
    message: userMessage(error),
  };
};

const errorCategory = (
  error: AnalysisError,
): AnalysisErrorProjection["category"] => {
  if (error._tag === "ProcessCaptureError")
    return error.userCategory ?? "execution_failure";
  if (
    error instanceof HopperRemoteError &&
    error.diagnosticType === "authorization"
  )
    return "permission_required";
  if (error instanceof ArtifactOperationError)
    return artifactErrorCategory(error.reason);
  if (error instanceof EvidenceFileError && error.reason === "disabled")
    return "unavailable";
  return STATIC_ERROR_CATEGORIES[error._tag] ?? "execution_failure";
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
  if (error instanceof AnalysisInputError)
    return "Analysis input is invalid. Check the arguments and try again.";
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

const KNOWN_ERROR_TAGS = {
  AnalysisProtocolError: true,
  AnalysisInputError: true,
  AnalysisOutputError: true,
  AnalysisCapabilityUnavailableError: true,
  AnalysisCancelledError: true,
  AnalysisTimeoutError: true,
  ProviderSelectionError: true,
  ProviderAdapterError: true,
  ArtifactOperationError: true,
  ProcessCaptureError: true,
  EvidenceIntegrityError: true,
  EvidenceLimitError: true,
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

const assertKnownTag = (tag: AnalysisErrorTag): void => {
  if (KNOWN_ERROR_TAGS[tag] !== true)
    throw new TypeError("Unknown analysis error tag");
};
