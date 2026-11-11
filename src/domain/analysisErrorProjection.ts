import { projectArtifactIntegrityDetails } from "./artifactIntegrity.js";
import {
  cleanupRetryRecovery,
  cleanupRetryRemediation,
  type AnalysisErrorRecovery,
} from "./analysisErrorRecovery.js";
import { jsonValueSchema, type JsonValue } from "./jsonValue.js";
import { isImmutableJsonSnapshot } from "./immutableJson.js";

import {
  analysisErrorCategory,
  UNRETAINED_EVIDENCE_EXPORT_GUIDANCE,
  analysisErrorRemediationAction,
  analysisErrorUserMessage,
  assertKnownAnalysisErrorTag,
  hasAnalysisContinuingCallerGuidance,
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
import {
  BinaryTargetError,
  ConfigurationError,
} from "./configurationErrors.js";
import { BrowserObservationError } from "./browserObservationError.js";
import {
  AnalysisSnapshotMismatchError,
  EvidenceFileError,
  EvidenceIntegrityError,
  EvidenceReferenceError,
} from "./evidenceErrors.js";
import {
  HopperCancelledError,
  HopperProcessError,
  HopperRemoteError,
  HopperStartError,
  HopperTimeoutError,
} from "./hopperErrors.js";
import { ProviderAdapterError } from "./providerAdapterError.js";
import { ProviderSelectionError } from "./providerSelectionError.js";
import { UnknownRegistryError } from "./unknownRegistryError.js";
import { providerRetryAction } from "./providerOperationHealth.js";
import {
  primaryAnalysisError,
  resolvedAnalysisError,
  sourcePublicationRecoveryOf,
  type AnalysisCallerLifetime,
  type AnalysisError,
  type AnalysisErrorOptions,
  type AnalysisErrorTag,
} from "./analysisErrorBase.js";
import { invocationSettingLimit } from "./analysisSettingDefinitions.js";

/**
 * Project expected failures into exhaustive, secret-safe caller fields. The
 * default describes a continuing caller, such as an MCP connection, and is
 * also the adapter-independent form retained inside Evidence. An adapter that
 * releases its provider session and runtime after this request, such as a
 * one-shot CLI command, passes `"invocation"`.
 */
export const projectAnalysisError = (
  error: AnalysisError,
  callerLifetime: AnalysisCallerLifetime = "continuing",
): AnalysisErrorProjection =>
  projectError(
    error,
    {
      capturedOutput: true,
      partialObservation: true,
      secondary: true,
    },
    callerLifetime,
  );

/** Cleanup history references output retained by its enclosing error owner. */
export const projectAnalysisErrorWithoutCapturedOutput = (
  error: AnalysisError,
  callerLifetime: AnalysisCallerLifetime = "continuing",
): AnalysisErrorProjection =>
  projectError(
    error,
    {
      capturedOutput: false,
      partialObservation: true,
      secondary: true,
    },
    callerLifetime,
  );

/** Bounded fallback when the completed observation itself cannot be delivered. */
export const projectAnalysisErrorWithoutPartialObservation = (
  error: AnalysisError,
  callerLifetime: AnalysisCallerLifetime = "continuing",
): AnalysisErrorProjection =>
  projectError(
    error,
    {
      capturedOutput: true,
      partialObservation: false,
      secondary: true,
    },
    callerLifetime,
  );

export interface UnretainedEvidenceCandidate {
  readonly field: "partial_observation" | "completed_observation";
  readonly secondaryPath: readonly number[];
  readonly value: JsonValue;
}

/** Enumerate recoveries owned by this projection, including secondary failures. */
export function* unretainedEvidenceCandidates(
  projected: AnalysisErrorProjection,
  secondaryPath: readonly number[] = [],
): Generator<UnretainedEvidenceCandidate> {
  for (const field of [
    "partial_observation",
    "completed_observation",
  ] as const) {
    const value = projected.details?.[field];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value.kind === "unretained-evidence" ||
        value.kind === "unretained-observation" ||
        value.kind === "inline-evidence")
    )
      yield { field, secondaryPath, value };
  }
  const secondary = projected.details?.secondary_failures;
  if (!Array.isArray(secondary)) return;
  for (const [index, failure] of secondary.entries()) {
    if (
      typeof failure !== "object" ||
      failure === null ||
      Array.isArray(failure)
    )
      continue;
    const remediation = failure.remediation;
    if (
      typeof remediation !== "object" ||
      remediation === null ||
      Array.isArray(remediation) ||
      typeof remediation.action !== "string"
    )
      continue;
    yield* unretainedEvidenceCandidates(
      failure as unknown as AnalysisErrorProjection,
      [...secondaryPath, index],
    );
  }
}

/** Omit one explicitly unretained recovery when a complete reply cannot fit. */
export const omitUnretainedEvidenceFromError = (
  projected: AnalysisErrorProjection,
  limit: {
    readonly constraint: "receive-buffer" | "string-length";
    readonly bytesAtLeast: number;
  },
  candidate: UnretainedEvidenceCandidate,
): AnalysisErrorProjection | undefined => {
  const { field, secondaryPath } = candidate;
  if (secondaryPath.length > 0) {
    const [index, ...rest] = secondaryPath;
    const secondary = projected.details?.secondary_failures;
    if (!Array.isArray(secondary) || index === undefined) return undefined;
    const failure = secondary[index];
    if (
      typeof failure !== "object" ||
      failure === null ||
      Array.isArray(failure)
    )
      return undefined;
    const omitted = omitUnretainedEvidenceFromError(
      failure as unknown as AnalysisErrorProjection,
      limit,
      { ...candidate, secondaryPath: rest },
    );
    if (omitted === undefined) return undefined;
    return {
      ...projected,
      details: {
        ...projected.details,
        secondary_failures: secondary.map((item, i) =>
          i === index ? omitted : item,
        ),
      },
    };
  }
  const partial = projected.details?.[field];
  if (
    typeof partial !== "object" ||
    partial === null ||
    Array.isArray(partial) ||
    (partial.kind !== "unretained-evidence" &&
      partial.kind !== "unretained-observation" &&
      partial.kind !== "inline-evidence")
  ) {
    return undefined;
  }
  const { [field]: _partial, ...details } = projected.details!;
  const evidence = partial.evidence;
  const evidenceId =
    typeof evidence === "object" &&
    evidence !== null &&
    !Array.isArray(evidence)
      ? evidence.evidence_id
      : undefined;
  const retention =
    partial.kind === "inline-evidence"
      ? typeof partial.retention === "string"
        ? partial.retention
        : "unknown"
      : "unretained";
  return {
    ...projected,
    remediation: {
      action: `${projected.remediation.action} ${recoveryOmissionRemediation(retention)}`,
    },
    details: {
      ...details,
      [`${field}_omitted`]: {
        reason: "mcp-response-limit",
        retention,
        constraint: limit.constraint,
        original_response_bytes_at_least: limit.bytesAtLeast,
        ...(typeof evidenceId === "string" ? { evidence_id: evidenceId } : {}),
        ...(field === "completed_observation"
          ? { source_closure: "not-established" }
          : {}),
      },
    },
  };
};

/** Explain the delivered omission without inferring ledger membership. */
export const recoveryOmissionRemediation = (retention: string): string =>
  retention === "unretained"
    ? "The omitted observation was not retained and could not fit within MCP delivery limits."
    : retention === "unknown"
      ? "The omitted observation's retention is unknown, and it could not fit within MCP delivery limits."
      : "The observation could not fit within MCP delivery limits.";

/** A child failure embedded in a composed error's diagnostics. */
export interface AnalysisChildFailure {
  readonly error: AnalysisError;
  /** Omit output that the composing error already retains. */
  readonly capturedOutput?: "omit";
  /** Omit recovery facts retained by the composing error. */
  readonly omitRecovery?: boolean;
}

/**
 * Record child failures as composition-time snapshots, so cleanup history
 * keeps the state it had. The invocation form is recorded only when a child's
 * projection depends on the caller lifetime; the final projection selects it.
 */
export const childFailureDiagnostics = (
  children: Readonly<Record<string, AnalysisChildFailure>>,
  diagnostics: Readonly<Record<string, JsonValue>> = {},
): Pick<AnalysisErrorOptions, "diagnostics" | "invocationDiagnostics"> => {
  const entries = Object.entries(children);
  const project = (
    { error, capturedOutput, omitRecovery }: AnalysisChildFailure,
    callerLifetime: AnalysisCallerLifetime,
  ) =>
    projectError(
      error,
      {
        capturedOutput: capturedOutput !== "omit",
        partialObservation: omitRecovery !== true,
        secondary: omitRecovery !== true,
      },
      callerLifetime,
    );
  const continuing = {
    ...diagnostics,
    ...Object.fromEntries(
      entries.map(([key, child]) => [key, project(child, "continuing")]),
    ),
  };
  const varying = entries.filter(([, { error, omitRecovery }]) =>
    projectionDependsOnCallerLifetime(error, omitRecovery !== true),
  );
  return varying.length === 0
    ? { diagnostics: continuing }
    : {
        diagnostics: continuing,
        invocationDiagnostics: {
          ...continuing,
          ...Object.fromEntries(
            varying.map(([key, child]) => [key, project(child, "invocation")]),
          ),
        },
      };
};

/** Check the primary chain and the secondary failures included in its projection. */
const projectionDependsOnCallerLifetime = (
  error: AnalysisError,
  includeSecondary: boolean,
): boolean => {
  const chainDepends = (first: AnalysisError): boolean => {
    for (
      let node: AnalysisError | undefined = first;
      node !== undefined;
      node = node.cleanupPrimary
    )
      if (
        node.limit !== undefined ||
        hasAnalysisContinuingCallerGuidance(node) ||
        node.invocationDiagnostics !== undefined ||
        node.workflowUnknownPublication !== undefined
      )
        return true;
    return false;
  };
  if (chainDepends(error)) return true;
  if (!includeSecondary) return false;
  for (
    let node: AnalysisError | undefined = error;
    node !== undefined;
    node = node.cleanupPrimary
  )
    if (node.secondaryFailures.some(chainDepends)) return true;
  return false;
};

const projectError = (
  error: AnalysisError,
  options: {
    readonly capturedOutput: boolean;
    readonly partialObservation: boolean;
    readonly secondary: boolean;
  },
  callerLifetime: AnalysisCallerLifetime,
): AnalysisErrorProjection => {
  const composed = error;
  error = resolvedAnalysisError(error);
  let diagnosticSource = error;
  while (
    diagnosticSource.diagnostics === undefined &&
    diagnosticSource.cleanupPrimary !== undefined
  )
    diagnosticSource = diagnosticSource.cleanupPrimary;
  const diagnostics = diagnosticSource.diagnosticsFor(callerLifetime);
  const cleanupHistory =
    composed === error ? undefined : composed.diagnosticsFor(callerLifetime);
  const capturedOutput = composed.capturedOutput ?? error.capturedOutput;
  const publication = sourcePublicationRecoveryOf(composed);
  const secondary = new Set<AnalysisError>();
  for (
    let owner: AnalysisError | undefined = composed;
    owner !== undefined;
    owner = owner.cleanupPrimary
  ) {
    for (const failure of owner.secondaryFailures) secondary.add(failure);
  }
  let partialObservation =
    composed.partialObservation ??
    error.partialObservation ??
    publication?.source;
  for (
    let owner = composed.cleanupPrimary;
    partialObservation === undefined && owner !== undefined;
    owner = owner.cleanupPrimary
  )
    partialObservation = owner.partialObservation;
  const completedSourceObservation =
    publication?.completed.kind === "omitted"
      ? undefined
      : publication?.completed;
  const completedSourceOmission =
    publication?.completed.kind === "omitted"
      ? {
          reason: publication.completed.reason,
          source_closure: publication.completed.source_closure,
        }
      : undefined;
  // A finalizer can add a report above the semantic primary, including while
  // its cleanup is pending or beneath another cleanup composition.
  let cleanupReport = composed.cleanupReport;
  for (
    let owner = composed.cleanupPrimary;
    cleanupReport === undefined && owner !== undefined;
    owner = owner.cleanupPrimary
  )
    cleanupReport = owner.cleanupReport;
  assertKnownAnalysisErrorTag(error._tag);
  const primary = primaryAnalysisError(error);
  assertKnownAnalysisErrorTag(primary._tag);
  const underlyingCode = underlyingErrorCode(primary);
  const code = error.cleanupIncomplete ? "cleanup_incomplete" : underlyingCode;
  const primaryDetails = errorDetails(primary);
  const unknownPublication =
    composed.workflowUnknownPublication ?? primary.workflowUnknownPublication;
  const details = {
    ...primaryDetails,
    ...(unknownPublication === undefined
      ? {}
      : {
          workflow_unknown_publication: {
            ...unknownPublication,
            evidence_retention:
              callerLifetime === "invocation" &&
              unknownPublication.evidence_retention === "retained"
                ? "invocation-only"
                : unknownPublication.evidence_retention,
          },
        }),
    ...(primary.limit === undefined
      ? {}
      : {
          limit:
            callerLifetime === "invocation"
              ? { ...invocationSettingLimit(primary.limit) }
              : { ...primary.limit },
        }),
    ...(!options.secondary || secondary.size === 0
      ? {}
      : {
          secondary_failures: [...secondary].map((failure) =>
            projectError(
              failure,
              { ...options, secondary: false },
              callerLifetime,
            ),
          ),
        }),
    ...(cleanupReport === undefined
      ? {}
      : { cleanup_report: jsonValueSchema.parse(cleanupReport) }),
    ...(diagnostics === undefined
      ? {}
      : {
          diagnostics,
          ...(primaryDetails?.diagnostics === undefined
            ? {}
            : { provider_diagnostics: primaryDetails.diagnostics }),
        }),
    ...(cleanupHistory === undefined
      ? {}
      : { cleanup_history: cleanupHistory }),
    ...(error.cleanupIncomplete
      ? {
          cleanup: "incomplete",
          resources: [...error.cleanupResources],
          ...(error.cleanup === undefined
            ? {}
            : { cleanup_reason: error.cleanup.reason }),
          execution_failure:
            primaryDetails?.execution_failure ?? underlyingCode,
        }
      : {}),
    ...(!options.capturedOutput || capturedOutput === undefined
      ? {}
      : {
          captured_output: {
            ...capturedOutput,
          },
        }),
    ...(!options.partialObservation || partialObservation === undefined
      ? {}
      : {
          partial_observation: isImmutableJsonSnapshot(partialObservation)
            ? partialObservation
            : jsonValueSchema.parse(partialObservation),
        }),
    ...(!options.partialObservation || completedSourceObservation === undefined
      ? {}
      : {
          completed_observation: isImmutableJsonSnapshot(
            completedSourceObservation,
          )
            ? completedSourceObservation
            : jsonValueSchema.parse(completedSourceObservation),
        }),
    ...(!options.partialObservation || completedSourceOmission === undefined
      ? {}
      : { completed_observation_omitted: completedSourceOmission }),
  };
  // The retained cleanup owner's retry precedes the failed operation's hint.
  const cleanupRetry = error.cleanupRetry;
  const recovery =
    cleanupRetry === undefined
      ? errorRecovery(error)
      : cleanupRetryRecovery(cleanupRetry);
  const remediation = analysisErrorRemediationAction(error, callerLifetime);
  const includesUnretainedEvidence =
    options.partialObservation &&
    [partialObservation, completedSourceObservation].some(
      (observation) =>
        typeof observation === "object" &&
        observation !== null &&
        "kind" in observation &&
        observation.kind === "unretained-evidence",
    );
  const retentionGuidance =
    error instanceof AnalysisResourceConstraintError &&
    error.resource === "capacity" &&
    includesUnretainedEvidence
      ? ` ${UNRETAINED_EVIDENCE_EXPORT_GUIDANCE}`
      : "";
  const publicationRemediation =
    callerLifetime === "continuing" &&
    unknownPublication?.evidence_retention === "retained"
      ? " Use get_evidence_bundle with the Evidence ID in details.workflow_unknown_publication to retrieve the completed result; use list_unknowns to inspect recorded questions. Publication stopped at the reported index; later questions were not checked in this attempt."
      : "";
  return {
    code,
    category: analysisErrorCategory(error),
    message: analysisErrorUserMessage(error, callerLifetime),
    retryable:
      RETRYABLE_CODES.has(code) ||
      (error instanceof AnalysisCapabilityUnavailableError &&
        error.retryable) ||
      (error._tag === "ProcessCaptureError" &&
        "retryable" in error &&
        error.retryable === true) ||
      (error instanceof ArtifactOperationError &&
        error.readerLimit?.can_increase === true &&
        !error.cleanupIncomplete) ||
      (code === "resource_constraint" &&
        error instanceof AnalysisResourceConstraintError &&
        (error.retryable ?? error.resource === "capacity")),
    remediation: {
      action:
        cleanupRetry === undefined
          ? `${remediation}${retentionGuidance}${publicationRemediation}`
          : `${remediation}${retentionGuidance} ${cleanupRetryRemediation(cleanupRetry)}${publicationRemediation}`,
    },
    ...(recovery === undefined ? {} : { recovery }),
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
};

const errorRecovery = (
  error: AnalysisError,
): AnalysisErrorRecovery | undefined => {
  if (error instanceof AnalysisInputError)
    return error.conformsToInputContract
      ? undefined
      : { kind: "inspect_input_contract", operation: error.operation };
  if (error instanceof AnalysisTimeoutError)
    return {
      kind: "inspect_timeout_state",
      operation: error.operation,
      timeout_ms: error.timeoutMs,
    };
  return undefined;
};

const underlyingErrorCode = (
  error: AnalysisError,
): AnalysisErrorProjection["code"] => {
  if (
    error instanceof HopperRemoteError &&
    error.diagnosticType === "invalid_request"
  )
    return "invalid_request";
  if (error instanceof ProviderSelectionError)
    return error.reason === "provider_unavailable"
      ? "provider_unavailable"
      : "capability_unavailable";
  if (error instanceof BrowserObservationError)
    return error.userCategory === "cancelled"
      ? "cancelled"
      : BROWSER_ERROR_CODES[error.reason];
  if (error instanceof ArtifactOperationError)
    return artifactOperationCode(error);
  if (error instanceof BinaryTargetError)
    return error.constraint === "load_selection_rejected"
      ? "invalid_request"
      : error.systemCode === undefined
        ? "target_unavailable"
        : "access_denied";
  if (error instanceof EvidenceFileError) return evidenceFileCode(error.reason);
  if (error instanceof UnknownRegistryError)
    return unknownRegistryCode(error.reason);
  if (error._tag === "ProcessCaptureError") return processCaptureCode(error);
  return staticErrorCode(error._tag);
};

const BROWSER_ERROR_CODES: Readonly<
  Record<BrowserObservationError["reason"], AnalysisErrorProjection["code"]>
> = {
  endpoint_unreachable: "provider_unavailable",
  invalid_endpoint_response: "unreadable_output",
  target_not_found: "target_unavailable",
  target_not_allowed: "target_unavailable",
  service_worker_blocked: "target_unavailable",
  target_changed: "target_unavailable",
  target_session_detached: "target_unavailable",
  protocol_error: "unreadable_output",
  disconnected: "provider_unavailable",
  payload_limit: "truncated",
  window_not_found: "unreadable_output",
  window_metadata_missing: "unreadable_output",
  process_ownership_unavailable: "unreadable_output",
  cleanup_failed: "execution_failure",
  cancelled: "cancelled",
  timeout: "provider_timeout",
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
  if (reason === "invalid-json") return "evidence_integrity_mismatch";
  if (reason === "path-limit" || reason === "storage-limit")
    return "resource_constraint";
  // A missing, non-file or already-existing path is the caller's selection.
  if (reason === "io") return "execution_failure";
  return "invalid_request";
};

const unknownRegistryCode = (
  reason: UnknownRegistryError["reason"],
): AnalysisErrorProjection["code"] => {
  if (reason === "revision-conflict") return "revision_conflict";
  if (reason === "already-exists" || reason === "constraint")
    return "invalid_request";
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
  | "BinaryTargetError"
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
    case "BinaryTargetError":
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
    return {
      operation: error.operation,
      reason: error.reason,
      ...(error.diagnostics === undefined
        ? {}
        : { diagnostics: error.diagnostics }),
    };
  if (error instanceof AnalysisInputError && error.issues.length > 0)
    return {
      operation: error.operation,
      issues: error.issues.map((issue) => ({
        path: [...issue.path],
        reason: issue.reason,
        ...(issue.message === undefined ? {} : { message: issue.message }),
        ...(issue.expected === undefined ? {} : { expected: issue.expected }),
        ...(issue.observed === undefined ? {} : { observed: issue.observed }),
        ...(issue.minimum === undefined ? {} : { minimum: issue.minimum }),
        ...(issue.maximum === undefined ? {} : { maximum: issue.maximum }),
      })),
    };
  if (error instanceof EvidenceReferenceError)
    return {
      evidence_id: error.evidenceId,
      reason: error.reason,
      ...(typeof error.diagnostics?.operation === "string"
        ? { operation: error.diagnostics.operation }
        : {}),
      ...(error.referenceScope === undefined
        ? {}
        : { reference_scope: error.referenceScope }),
      expected: error.expected,
      actual: error.actual,
    };
  if (error instanceof AnalysisSnapshotMismatchError)
    return {
      reason: error.message,
      ...(error.bindingMismatch === undefined
        ? {}
        : { binding_mismatch: jsonValueSchema.parse(error.bindingMismatch) }),
    };
  if (error instanceof EvidenceIntegrityError) return { reason: error.message };
  return undefined;
};

const artifactStateErrorDetails = (
  error: AnalysisError,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (error instanceof ArtifactOperationError && error.artifactDetails)
    return projectArtifactIntegrityDetails(error.artifactDetails);
  if (error instanceof ArtifactOperationError)
    return {
      operation: error.operation,
      reason: error.reason,
      ...(error.reason === "limit" ? { truncated: true } : {}),
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.boundary === undefined ? {} : { boundary: error.boundary }),
      ...(error.readerLimit === undefined
        ? {}
        : { reader_limit: { ...error.readerLimit } }),
      ...(error.admission === undefined
        ? {}
        : {
            admission: error.admission.kind,
            ...(error.admission.kind === "asar-header"
              ? {
                  maximum_header_bytes: error.admission.maximumBytes,
                  maximum_header_bytes_source: error.admission.source,
                  setting: "REA_ASAR_MAX_HEADER_BYTES",
                }
              : {
                  maximum_listing_bytes: error.admission.maximumBytes,
                  maximum_listing_bytes_source: error.admission.source,
                  setting: "REA_ASAR_MAX_LISTING_BYTES",
                }),
          }),
    };
  if (error instanceof UnknownRegistryError)
    return {
      reason: error.reason,
      ...(error.constraint === undefined
        ? {}
        : { constraint: error.constraint }),
    };
  if (error instanceof EvidenceFileError)
    return {
      operation: error.operation,
      reason: error.reason,
      ...(error.reason === "path-limit" ? { boundary: "filesystem-path" } : {}),
      ...(error.systemCode === undefined
        ? {}
        : { system_code: error.systemCode }),
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.contentIssues === undefined
        ? {}
        : {
            content_issues: error.contentIssues.map((issue) => ({
              ...issue,
              path: [...issue.path],
            })),
          }),
      ...(error.published === undefined
        ? {}
        : {
            published: true,
            bytes: error.published.bytes,
            ...(error.published.path === undefined
              ? {}
              : { published_path: error.published.path }),
          }),
    };
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
        origin: rejection.origin,
        code: rejection.code,
        reason: rejection.reason,
        ...(rejection.remediation === undefined
          ? {}
          : { remediation: rejection.remediation }),
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
  if (error instanceof HopperProcessError) {
    const stage = error.stage;
    return {
      exit_code: error.exitCode,
      stage,
      provider_state: error.providerState,
      retry_action: providerRetryAction(
        error.providerState,
        error.failureCode !== undefined || error.stage === "launch",
      ),
      ...(error.failureCode === undefined
        ? {}
        : { failure_code: error.failureCode }),
      ...(error.operation === undefined ? {} : { operation: error.operation }),
      ...(error.requestId === undefined ? {} : { request_id: error.requestId }),
      ...(error.diagnostic === undefined
        ? {}
        : { diagnostics: { ...error.diagnostic } }),
      ...(error.launcherFailure === undefined
        ? {}
        : { launcher: error.launcherFailure }),
    };
  }
  if (error instanceof HopperStartError)
    return {
      stage: "launch",
      provider_state: "unknown",
      ...(error.launchRejection === undefined
        ? {}
        : { launch_rejection: { ...error.launchRejection } }),
      retry_action: error.ownerRunId === undefined ? "retry" : "unknown",
      ...(error.ownerRunId === undefined
        ? {}
        : { owner_run_id: error.ownerRunId }),
      ...(error.launcherFailure === undefined
        ? {}
        : { launcher: error.launcherFailure }),
    };
  return undefined;
};

const primaryBrowserFailureReason = (
  error: BrowserObservationError,
): string | undefined => {
  const aggregate = error.cause instanceof AggregateError;
  const primary =
    error.cause instanceof AggregateError ? error.cause.errors[0] : error.cause;
  if (primary instanceof BrowserObservationError) return primary.reason;
  if (primary instanceof AnalysisCancelledError) return "cancelled";
  if (primary instanceof AnalysisTimeoutError) return "timeout";
  if (typeof primary === "object" && primary !== null && "_tag" in primary)
    return typeof primary._tag === "string"
      ? primary._tag
      : "execution_failure";
  return aggregate ? "execution_failure" : undefined;
};

const lifecycleErrorDetails = (
  error: AnalysisError,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (error instanceof AnalysisCancelledError)
    return {
      operation: error.operation,
      cleanup: error.cleanupIncomplete ? "incomplete" : "complete",
      ...(error.cleanup === undefined || !error.cleanupIncomplete
        ? {}
        : {
            cleanup_reason: error.cleanup.reason,
            resources: [...error.cleanup.resources],
            execution_failure: "cancelled",
          }),
    };
  if (error instanceof HopperCancelledError)
    return { operation: "hopper", cleanup: "complete" };
  if (error instanceof AnalysisTimeoutError)
    return {
      operation: error.operation,
      timeout_ms: error.timeoutMs,
      ...(error.cleanup === undefined || !error.cleanupIncomplete
        ? {}
        : {
            cleanup: "incomplete",
            cleanup_reason: error.cleanup.reason,
            resources: [...error.cleanup.resources],
          }),
    };
  if (error instanceof HopperTimeoutError)
    return {
      stage: error.operation === undefined ? "startup" : error.stage,
      timeout_ms: error.timeoutMs,
      ...(error.launcherOutcome === undefined
        ? {}
        : { launcher: error.launcherOutcome }),
      provider_state: error.providerState,
      retry_action: error.providerState === "busy" ? "wait" : "retry",
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
    };
  if (error._tag === "ProcessCaptureError") {
    const details = {
      ...(error.userCategory === "cancelled"
        ? { operation: "process_capture", cleanup: "complete" }
        : {}),
      ...(error.cleanupReport === undefined
        ? {}
        : { cleanup_report: jsonValueSchema.parse(error.cleanupReport) }),
      ...(error.executionFailure === undefined
        ? {}
        : { execution_failure: error.executionFailure }),
    };
    return Object.keys(details).length === 0 ? undefined : details;
  }
  if (error instanceof ConfigurationError && error.settings.length > 0)
    return {
      settings: error.settings.map((issue) => ({
        setting: issue.setting,
        constraint: issue.constraint,
        ...(issue.update_mode === undefined
          ? {}
          : { update_mode: issue.update_mode }),
        ...(issue.pending_restart === undefined
          ? {}
          : { pending_restart: issue.pending_restart }),
      })),
    };
  if (error instanceof BinaryTargetError)
    return {
      path: error.path,
      reason: error.reason,
      ...(error.constraint === undefined
        ? {}
        : { constraint: error.constraint }),
      ...(error.infoPlist === undefined ? {} : { info_plist: error.infoPlist }),
      ...(error.probedPaths === undefined
        ? {}
        : { probed_paths: [...error.probedPaths] }),
      ...(error.systemCode === undefined
        ? {}
        : { system_code: error.systemCode, boundary: "filesystem-read" }),
    };
  return undefined;
};

const RETRYABLE_CODES: ReadonlySet<AnalysisErrorProjection["code"]> = new Set([
  "artifact_changed",
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
  readonly recovery?: AnalysisErrorRecovery;
  readonly details?: Readonly<Record<string, JsonValue>>;
}
