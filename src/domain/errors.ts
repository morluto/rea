import type { JsonValue } from "./jsonValue.js";

/** Stable tags exposed by safe analysis-error projections. */
export const ANALYSIS_ERROR_TAGS = [
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
] as const;

/** Stable tag for an expected analysis failure. */
export type AnalysisErrorTag = (typeof ANALYSIS_ERROR_TAGS)[number];

/** Base class for expected analysis, provider, and session failures. */
export abstract class AnalysisError extends Error {
  abstract readonly _tag: AnalysisErrorTag;
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
  readonly tag: AnalysisErrorTag;
  readonly message: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

/** Project expected failures into exhaustive, secret-safe caller fields. */
export const projectAnalysisError = (
  error: AnalysisError,
): AnalysisErrorProjection => {
  assertKnownTag(error._tag);
  return {
    tag: error._tag,
    message: error.message,
    details: safeDetails(error),
  };
};

const safeDetails = (
  error: AnalysisError,
): Readonly<Record<string, string | number | boolean | null>> => {
  if (error instanceof AnalysisInputError)
    return { operation: error.operation };
  if (error instanceof AnalysisOutputError)
    return { operation: error.operation, reason: error.reason };
  if (error instanceof AnalysisCapabilityUnavailableError)
    return {
      providerId: error.providerId,
      operation: error.operation,
      reason: error.reason,
    };
  if (error instanceof AnalysisCancelledError)
    return { operation: error.operation };
  if (error instanceof AnalysisTimeoutError)
    return { operation: error.operation, timeoutMs: error.timeoutMs };
  if (error instanceof ProviderSelectionError)
    return { operation: error.operation };
  if (error instanceof ProviderAdapterError)
    return { providerId: error.providerId, operation: error.operation };
  if (error instanceof ArtifactOperationError)
    return {
      operation: error.operation,
      reason: error.reason,
      ...error.artifactDetails,
    };
  if (error instanceof EvidenceLimitError)
    return { limit: error.limit, maximum: error.maximum };
  if (error instanceof EvidenceFileError)
    return { operation: error.operation, reason: error.reason };
  if (error instanceof InvestigationWorkspaceError)
    return { operation: error.operation, reason: error.reason };
  if (error instanceof UnknownRegistryError) return { reason: error.reason };
  if (error instanceof HopperTimeoutError)
    return { timeoutMs: error.timeoutMs };
  if (error instanceof HopperRemoteError)
    return {
      code: error.code,
      safeMessage: error.safeMessage,
      diagnosticType: error.diagnosticType,
    };
  if (error instanceof HopperProcessError) return { exitCode: error.exitCode };
  return {};
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
} as const satisfies Readonly<Record<AnalysisErrorTag, true>>;

const assertKnownTag = (tag: AnalysisErrorTag): void => {
  if (KNOWN_ERROR_TAGS[tag] !== true)
    throw new TypeError("Unknown analysis error tag");
};
