import { describeResidualUnknownGraphConstraint } from "./residualUnknownGraphError.js";
import { WABT_RELEASE_LINE } from "./wasm/wasmArtifact.js";
import { knownArgumentMistakeRemediation } from "./inputArgumentGuidance.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisTargetFailureError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "./analysisErrorCore.js";
import { targetFailureRecovery } from "./targetFailure.js";
import { ArtifactOperationError } from "./artifactOperationError.js";
import {
  INFO_PLIST_DECODE_MIB,
  OPENABLE_APPLE_BUNDLE_TYPES_TEXT,
} from "./apple/appleBundleTypes.js";
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
  AnalysisSnapshotMismatchError,
  ResourceSnapshotMismatchError,
} from "./evidenceErrors.js";
import { ProviderSelectionError } from "./providerSelectionError.js";
import { ProviderAdapterError } from "./providerAdapterError.js";
import { isDoctorProviderId } from "./doctorProviderIds.js";
import { UnknownRegistryError } from "./unknownRegistryError.js";
import { analysisErrorRefusal } from "./analysisErrorRefusal.js";
import { classifyAnalysisError } from "./analysisErrorClassification.js";
import {
  analysisRefusalMessage,
  analysisRefusalRemediation,
} from "./analysisRefusal.js";
import {
  primaryAnalysisError,
  resolvedAnalysisError,
  type AnalysisCallerLifetime,
  type AnalysisContinuingCallerGuidance,
  type AnalysisError,
  type AnalysisErrorTag,
  type AnalysisRelatedInputs,
  domainErrorTag,
  ProviderOwnedAnalysisError,
} from "./analysisErrorBase.js";
import type { AnalysisErrorProjection } from "./analysisErrorProjection.js";

/**
 * How one adapter names the operation in an input-schema refusal. MCP names
 * the tool and tells the client to refresh its catalog. The CLI names the
 * command and omits that client-only clause.
 */
export interface InputSchemaRemediationSpelling {
  readonly subject: (operation: string) => string;
  readonly includeCatalogRefresh: boolean;
}

/** The MCP spelling, which is also the adapter-independent one in Evidence. */
export const MCP_INPUT_SCHEMA_SPELLING: InputSchemaRemediationSpelling = {
  subject: (operation) => operation,
  includeCatalogRefresh: true,
};

/** The input-schema refusal, in one adapter's spelling. */
export const renderInputSchemaRemediation = (
  operation: string,
  spelling: InputSchemaRemediationSpelling,
): string => {
  const subject = spelling.subject(operation);
  const refresh = spelling.includeCatalogRefresh
    ? "; if using MCP and the catalog may be stale, call tools/list"
    : "";
  return `Read the declared input schema or CLI usage for ${subject}${refresh}. Correct the listed fields, then retry. Do not repeat the unchanged call.`;
};

/** Explain how to preserve an observation the session could not retain. */
export const UNRETAINED_EVIDENCE_EXPORT_GUIDANCE =
  "Unretained Evidence is not included in the exported investigation; if present in this response, save it separately.";

/** File export when one MCP frame cannot carry the retained session bundle. */
export const MCP_TRANSPORT_EVIDENCE_EXPORT =
  "Export complete retained session evidence through export_evidence_bundle to a caller-selected path, or use complete CLI JSON output. The connection remains usable.";

/** Next step when one MCP frame cannot carry a complete retained session bundle. */
export const MCP_TRANSPORT_EVIDENCE_DISCOVERY = `Discover retained records with get_evidence_bundle and detail: summary, selecting a limit and following page.next_offset; then read selected complete records with detail: records and an exact evidence_id, or inspect compatible records through inspect_analysis_view using an exact Evidence reference. ${MCP_TRANSPORT_EVIDENCE_EXPORT}`;

/** Next step when one MCP frame cannot carry the selected metadata rows. */
export const MCP_TRANSPORT_EVIDENCE_SUMMARY = `Request fewer metadata rows with get_evidence_bundle detail: summary, the same filters and offset, and a smaller limit; follow page.next_offset after each successful page. A single metadata row larger than one response still needs export. ${MCP_TRANSPORT_EVIDENCE_EXPORT}`;

/** Next step when one MCP frame cannot carry a selected page of complete records. */
export const MCP_TRANSPORT_EVIDENCE_RECORDS = `Request fewer records with get_evidence_bundle detail: records, a smaller limit or an exact evidence_id filter; inspect compatible records in pages through inspect_analysis_view. A single record larger than one response needs export. ${MCP_TRANSPORT_EVIDENCE_EXPORT}`;

/** Next step when one MCP frame cannot carry a selected page of link rows. */
export const MCP_TRANSPORT_EVIDENCE_LINKS =
  "Request fewer rows with get_evidence_bundle detail: links, a smaller limit or an exact evidence_id filter, then follow next_offset.";

/** Name the next step that is true for how long the caller keeps REA's runtime and session. */
export const analysisErrorRemediationAction = (
  error: AnalysisError,
  callerLifetime: AnalysisCallerLifetime = "continuing",
): string => {
  error = resolvedAnalysisError(error);
  const continuing =
    callerLifetime === "continuing"
      ? (error.continuingCallerGuidance?.remediationAction ??
        error.ownPresentation()?.continuing?.remediationAction)
      : undefined;
  if (continuing !== undefined) return continuing;
  const owned = error.ownPresentation()?.remediation;
  if (owned !== undefined) return owned;
  if (
    (error instanceof ProviderAdapterError ||
      error instanceof AnalysisCapabilityUnavailableError) &&
    error.remediationAction !== undefined
  )
    return error.remediationAction;
  if (error instanceof ProviderAdapterError && error.userMessage === undefined)
    return unclassifiedProviderRemediation(error.providerId);
  if (
    error instanceof BrowserObservationError &&
    error.remediationAction !== undefined
  )
    return error.remediationAction;
  if (
    error instanceof BrowserObservationError &&
    error.reason === "service_worker_blocked"
  )
    return "Set environment.service_workers to allow to permit this capture, or remove the service worker registration through the browser. REA never removes existing registrations.";
  if (error instanceof AnalysisCapabilityUnavailableError && error.retryable)
    return "Review details.reason, then retry the same analysis after the condition clears.";
  if (
    error instanceof AnalysisCapabilityUnavailableError &&
    error.fallbackRemediationAction !== undefined
  )
    return error.fallbackRemediationAction;
  if (error instanceof EvidenceFileError && error.published !== undefined)
    return error.published.path === undefined
      ? "Resolve the reported staging cleanup failure. Publication completed; its path identity is excluded."
      : "Use the published file at details.published_path and resolve the reported staging cleanup failure.";
  if (
    error instanceof ProviderSelectionError &&
    error.remediationAction !== undefined
  )
    return error.remediationAction;
  if (error instanceof ResourceSnapshotMismatchError)
    return error.operation === "export"
      ? "Call close_binary without snapshot_path to close this resource-only session."
      : "Open an executable analysis target before importing a binary analysis snapshot.";
  if (error instanceof AnalysisSnapshotMismatchError)
    return "Select an artifact, provider, and analysis profile matching the snapshot, or run analysis without it and save a fresh snapshot for the intended binding.";
  if (error instanceof AnalysisTargetFailureError)
    return targetFailureRecovery(
      error.operation,
      error.failure,
      analysisErrorRelatedInputs(error),
    );
  if (error instanceof AnalysisResourceConstraintError) {
    if (error.remediationAction !== undefined) return error.remediationAction;
    const refusal = analysisErrorRefusal(error);
    return refusal === undefined
      ? measuredResourceRemediation(error.resource)
      : analysisRefusalRemediation(refusal, callerLifetime);
  }
  if (
    error instanceof AnalysisTimeoutError &&
    error.remediationAction !== undefined
  )
    return error.remediationAction;
  if (error instanceof AnalysisTimeoutError) return timeoutRemediation(error);
  if (
    error instanceof ArtifactOperationError &&
    error.remediationAction !== undefined
  )
    return error.remediationAction;
  if (error instanceof ArtifactOperationError) {
    const refusal = analysisErrorRefusal(error);
    if (refusal !== undefined)
      return analysisRefusalRemediation(refusal, callerLifetime);
  }
  if (
    error instanceof ArtifactOperationError &&
    error.readerLimit !== undefined
  )
    return error.userMessage ?? error.detail ?? error.message;
  if (
    error instanceof ArtifactOperationError &&
    error.reason === "limit" &&
    error.boundary === "capacity"
  )
    return "Use an artifact within the capacity reported in details.detail. Changing output detail or retrying the unchanged input does not remove this boundary.";
  if (error instanceof EvidenceReferenceError)
    return error.reason === "missing" &&
      error.referenceScope === "retained-closure"
      ? "Import the originating Evidence bundle with the selected records and their complete linked sources into the current investigation, or re-run their producers there. Retry after the required records are retained. reset_investigation clears retained records; close_binary preserves them."
      : "Use an exact Evidence reference available from the selected source, supply the complete inline Evidence, re-run its producer, or select/import its Evidence bundle. reset_investigation clears retained records; close_binary preserves them.";
  if (
    error instanceof BinaryTargetError &&
    error.remediationAction !== undefined
  )
    return error.remediationAction;
  if (
    error instanceof BinaryTargetError &&
    error.constraint === "directory_requires_file"
  )
    return `For a desktop installation or native build directory, call inspect_desktop_application or audit_release_exposure with the directory; for a JavaScript/Electron application directory, call analyze_javascript_application with input_path. To analyze one program, select its file or an Apple bundle directory (${OPENABLE_APPLE_BUNDLE_TYPES_TEXT}).`;
  if (
    error instanceof BinaryTargetError &&
    error.constraint === "bundle_type_unsupported"
  )
    return `Select the bundle's program file directly, or open a bundle directory of a supported type (${OPENABLE_APPLE_BUNDLE_TYPES_TEXT}).`;
  if (
    error instanceof BinaryTargetError &&
    (error.constraint === "bundle_executable_undeclared" ||
      error.constraint === "bundle_program_missing") &&
    error.infoPlist !== undefined
  )
    return `Read ${error.infoPlist} with inspect_plist to review its CFBundleExecutable, then select an existing program file directly.`;
  if (
    error instanceof BinaryTargetError &&
    error.constraint === "bundle_info_plist_decode_budget_exceeded"
  )
    return `Reduce the Info.plist below the ${INFO_PLIST_DECODE_MIB} MiB decoded representation allowance, then retry opening the bundle.`;
  if (
    error instanceof BinaryTargetError &&
    (error.constraint === "bundle_info_plist_missing" ||
      error.constraint === "bundle_layout_ambiguous" ||
      error.constraint === "bundle_current_version_missing" ||
      error.constraint === "bundle_path_escapes")
  )
    return "Review the bundle paths listed in details, then select the bundle's program file directly or repair the bundle layout.";
  if (
    error instanceof BinaryTargetError &&
    error.constraint === "load_selection_rejected"
  )
    return "Correct the reported load argument (format, architecture, architecture_variant, entry_point, base_address, or vector_table_address) and retry.";
  if (
    error instanceof BinaryTargetError &&
    error.constraint === "file_format_rejected"
  )
    return "Review the reported file-format reason and select a supported, well-formed target.";
  if (
    error instanceof BinaryTargetError &&
    error.constraint === "wasm_requires_static_inspection"
  )
    return `For static inspection, call inspect_wasm_artifact with ${JSON.stringify({ path: error.path })}. This separate lane requires caller-supplied ${WABT_RELEASE_LINE} via absolute REA_WABT_BIN_DIRECTORY; check its availability in binary_session. REA does not execute WASM or install tools, and the header alone does not establish that the complete module is valid.`;
  if (
    error instanceof AnalysisAccessDeniedError ||
    (error instanceof BinaryTargetError && error.systemCode !== undefined)
  )
    return "Check the current process's read access to the selected path. Retry with a readable local file.";
  if (error instanceof AnalysisArtifactChangedError)
    return "Wait until the selected file is stable. For an active binary session, reopen the target with open_binary before retrying so REA acquires its current identity; for a CLI command or target-free tool, rerun the operation.";
  if (error instanceof ConfigurationError)
    return (
      error.remediationAction ??
      (error.settings.length > 0
        ? `Correct ${[...new Set(error.settings.map(({ setting }) => setting))].join(", ")} in the environment that starts REA (your shell or the MCP client's registration), then rerun.`
        : analysisErrorUserMessage(error))
    );
  if (error instanceof AnalysisInputError) {
    const refusal = analysisErrorRefusal(error);
    if (error.remediationAction === undefined && refusal !== undefined)
      return analysisRefusalRemediation(refusal, callerLifetime);
    const mistakeRemediation = knownArgumentMistakeRemediation(
      error.operation,
      error.issues,
    );
    const baseAction =
      error.remediationAction ??
      renderInputSchemaRemediation(error.operation, MCP_INPUT_SCHEMA_SPELLING);
    return mistakeRemediation === undefined
      ? baseAction
      : `${mistakeRemediation} ${baseAction}`;
  }
  if (
    error instanceof AnalysisOutputError &&
    error.remediationAction !== undefined
  )
    return error.remediationAction;
  if (
    error instanceof UnknownRegistryError &&
    error.reason === "constraint" &&
    error.constraint !== undefined
  ) {
    const suffix = " Do not repeat the unchanged call.";
    switch (error.constraint.kind) {
      case "missing_evidence":
        return (
          "Use an Evidence ID retained in this session; obtain or import the missing Evidence before referencing it." +
          suffix
        );
      case "missing_unknown":
        return (
          "Use an unknown_id retained in this session; create or import the related unknown before referencing it." +
          suffix
        );
      case "resolution_unproven":
        return (
          "Supply supporting non-mutation Evidence matching the unknown's required authority, confidence and environment, or withdraw the unsupported resolution." +
          suffix
        );
      case "contradicting_evidence":
        return (
          "Reconcile the contradicting Evidence before claiming a verified resolution." +
          suffix
        );
      case "dependency_cycle":
        return (
          "Correct the depends-on relationships to remove the dependency cycle." +
          suffix
        );
      case "history_gap":
      case "revision_chain":
        break;
    }
  }
  if (error instanceof UnknownRegistryError && error.reason === "not-found")
    return "Check that the unknown_id belongs to this session, then retry.";
  return analysisErrorUserMessage(error);
};

/**
 * Recovery for a measured exhaustion or occupied admission. A typed refusal
 * never reaches this: its own variant names the recovery.
 */
const measuredResourceRemediation = (
  resource: AnalysisResourceConstraintError["resource"],
): string => {
  switch (resource) {
    case "capacity":
      return "Wait for an active analysis to complete, then retry within the reported admission limits.";
    case "transport":
      return MCP_TRANSPORT_EVIDENCE_DISCOVERY;
    case "cpu":
      return "Review the reported worker CPU limits and observed signal. Retry with sufficient CPU time or a smaller artifact; REA retains tighter inherited limits.";
    case "file-size":
      return "Review the reported worker file-size limits and write failure. Retry with a sufficient file-size allowance for the evidence reply; REA retains tighter inherited limits.";
    case "memory":
      return "Review the reported worker memory limits and available host memory. Retry with sufficient memory or a smaller artifact; REA retains tighter inherited limits.";
  }
};

export const analysisErrorCategory = (
  error: AnalysisError,
): AnalysisErrorProjection["category"] =>
  classifyAnalysisError(primaryAnalysisError(error)).category;

/** Describe the request's outcome, adding continuing-caller facts only for that caller. */
export const analysisErrorUserMessage = (
  error: AnalysisError,
  callerLifetime: AnalysisCallerLifetime = "continuing",
): string => {
  const { outcome, continuing } = analysisErrorUserMessageParts(error);
  return callerLifetime === "invocation" || continuing === undefined
    ? outcome
    : `${outcome} ${continuing}`;
};

/** The outcome every caller receives and the addition only a continuing caller does. */
const analysisErrorUserMessageParts = (
  error: AnalysisError,
): { readonly outcome: string; readonly continuing?: string } => {
  error = resolvedAnalysisError(error);
  const outcome = outcomeUserMessage(error);
  const continuing =
    error.continuingCallerGuidance?.userMessage ??
    error.ownPresentation()?.continuing?.userMessage;
  return continuing === undefined ? { outcome } : { outcome, continuing };
};

/** Whether a child diagnostic needs a distinct continuing guidance snapshot. */
export const hasAnalysisContinuingCallerGuidance = (
  error: AnalysisError,
): boolean =>
  error.continuingCallerGuidance !== undefined ||
  error.ownPresentation()?.continuing !== undefined;

/** A declared recovery action is distinct from a category's generic fallback. */
const hasAuthoredRemediation = (
  error: AnalysisError,
  callerLifetime: AnalysisCallerLifetime,
): boolean =>
  (callerLifetime === "continuing" &&
    error.continuingCallerGuidance?.remediationAction !== undefined) ||
  ("remediationAction" in error &&
    typeof error.remediationAction === "string") ||
  (error instanceof AnalysisCapabilityUnavailableError &&
    error.fallbackRemediationAction !== undefined);

/**
 * Re-attribute one failure's message and another's remediation to a composed
 * error, keeping the form each caller lifetime receives.
 */
export const composedCallerGuidance = (sources: {
  readonly message?: AnalysisError;
  readonly remediation: AnalysisError;
}): {
  readonly userMessage?: string;
  readonly remediationAction: string;
  readonly continuingCallerGuidance?: AnalysisContinuingCallerGuidance;
} => {
  const message =
    sources.message === undefined
      ? undefined
      : analysisErrorUserMessageParts(sources.message);
  const remediationOwner = (lifetime: AnalysisCallerLifetime) =>
    hasAuthoredRemediation(sources.remediation, lifetime)
      ? sources.remediation
      : sources.message !== undefined &&
          hasAuthoredRemediation(sources.message, lifetime)
        ? sources.message
        : sources.remediation;
  const remediationAction = analysisErrorRemediationAction(
    remediationOwner("invocation"),
    "invocation",
  );
  const continuingRemediation = analysisErrorRemediationAction(
    remediationOwner("continuing"),
  );
  const continuingCallerGuidance = {
    ...(message?.continuing === undefined
      ? {}
      : { userMessage: message.continuing }),
    ...(continuingRemediation === remediationAction
      ? {}
      : { remediationAction: continuingRemediation }),
  };
  return {
    ...(message === undefined ? {} : { userMessage: message.outcome }),
    remediationAction,
    ...(Object.keys(continuingCallerGuidance).length === 0
      ? {}
      : { continuingCallerGuidance }),
  };
};

const outcomeUserMessage = (error: AnalysisError): string => {
  if (error instanceof AnalysisSnapshotMismatchError) return error.message;
  if (error instanceof AnalysisTargetFailureError) return error.message;
  if (error instanceof AnalysisResourceConstraintError) return error.reason;
  if (error instanceof AnalysisAccessDeniedError)
    return "Host filesystem permissions denied read access to the selected path.";
  if (error instanceof AnalysisArtifactChangedError)
    return "The selected artifact changed during acquisition; no stable snapshot was decoded.";
  if (error instanceof AnalysisInputError) {
    const refusal = analysisErrorRefusal(error);
    return (
      error.userMessage ??
      (refusal === undefined ? undefined : analysisRefusalMessage(refusal)) ??
      "Analysis input is invalid. Check the arguments and try again."
    );
  }
  if (error instanceof AnalysisTimeoutError)
    return error.userMessage ?? timeoutUserMessage(error);
  const ownedMessage = error.ownPresentation()?.message;
  if (ownedMessage !== undefined) return ownedMessage;
  if (error.userMessage !== undefined) return error.userMessage;
  if (error instanceof AnalysisCapabilityUnavailableError && error.retryable)
    return "Required runtime controls are unavailable for this attempt.";
  if (error instanceof ProviderAdapterError)
    return `The ${error.providerId} provider could not complete ${error.operation}, and REA did not classify the failure. Any reason the provider reported is in details.diagnostics.`;
  const standardMessage = standardErrorMessage(error);
  if (standardMessage !== undefined) return standardMessage;
  if (error instanceof ArtifactOperationError) return artifactMessage(error);
  if (error instanceof EvidenceReferenceError)
    return error.reason === "missing"
      ? error.referenceScope === "retained-closure"
        ? `Evidence ${error.evidenceId} is missing from the required retained Evidence closure in the current investigation. Import its originating bundle or re-create the required observations before retrying.`
        : `Evidence ${error.evidenceId} is not available from the selected source. Supply complete inline Evidence, re-run its producer, or select/import its bundle before using this reference.`
      : `Evidence ${error.evidenceId} does not match the requested reference (${error.reason}). Check the expected and actual identity in the diagnostic details.`;
  if (error instanceof EvidenceIntegrityError)
    return "Evidence is invalid or has changed. Recreate or re-import it, then try again.";
  if (error instanceof EvidenceFileError) return evidenceFileMessage(error);
  if (
    error instanceof UnknownRegistryError &&
    error.reason === "already-exists"
  )
    return "This residual unknown already exists in the session. Reuse it or call update_unknown with its current expected_revision; do not repeat record_unknown.";
  if (error instanceof UnknownRegistryError && error.reason === "not-found")
    return "The requested residual unknown does not exist in this session. Check the unknown_id and try again.";
  if (error instanceof UnknownRegistryError && error.constraint !== undefined)
    return describeResidualUnknownGraphConstraint(error.constraint);
  if (error instanceof UnknownRegistryError)
    return "Evidence state changed before the update completed. Refresh the current state and try again.";
  if (error instanceof ConfigurationError)
    return error.settings.length === 0
      ? "REA configuration is invalid. Run `rea doctor` and fix the reported setting."
      : `REA configuration is invalid: ${error.settings
          .map(({ setting, constraint }) =>
            constraint.includes(setting)
              ? constraint.replace(/\.$/u, "")
              : `${setting}: ${constraint}`,
          )
          .join("; ")}.`;
  if (error instanceof NoBinaryOpenError) return error.message;
  if (
    error instanceof BinaryTargetError &&
    error.constraint === "wasm_requires_static_inspection"
  )
    return `${error.message}. Static WebAssembly inspection uses a separate optional WABT lane, not a native analysis engine.`;
  if (error instanceof BinaryTargetError)
    return error.constraint === "directory_requires_file"
      ? `This operation opens a file or an Apple bundle directory (${OPENABLE_APPLE_BUNDLE_TYPES_TEXT}); this target is another directory. Directory-capable operations are inspect_desktop_application, audit_release_exposure, and analyze_javascript_application for JavaScript/Electron applications.`
      : error.constraint === undefined
        ? `${error.message}. Check that the path exists, is readable, and points to a supported file.`
        : `${error.message}.`;
  if (error._tag === "ProcessCaptureError")
    return (
      error.userMessage ??
      "Process capture could not complete. Review the reported details and capture policy, then try again."
    );
  return "Analysis could not complete, and REA did not classify the failure. Review the reported details.";
};

/**
 * Recovery for a provider failure no typed variant classified. Doctor is
 * named only for providers whose readiness it can check.
 */
const unclassifiedProviderRemediation = (providerId: string): string =>
  isDoctorProviderId(providerId)
    ? `Review the reported details. If the ${providerId} installation or configuration may be at fault, run \`rea doctor --provider ${providerId}\` and apply its fixes. Repeating the unchanged request is not expected to succeed.`
    : "Review the reported details for the provider's reason; REA has no specific recovery for this unclassified failure. Repeating the unchanged request is not expected to succeed.";

/**
 * Standard text by tag, or by the code an error that presents itself
 * declares, when nothing more specific describes the outcome.
 */
const standardErrorMessage = (error: AnalysisError): string | undefined => {
  const tag = error._tag;
  const code = error.ownPresentation()?.code;
  if (UNREADABLE_OUTPUT_TAGS.has(tag) || code === "unreadable_output")
    return "Analysis returned a result REA could not read. Review the reported details; repeating the unchanged request is not expected to succeed.";
  if (UNSUPPORTED_PROVIDER_TAGS.has(tag))
    return "This analysis is unavailable for the current target. Choose another analysis or target.";
  if (CANCELLED_TAGS.has(tag) || code === "cancelled")
    return "Analysis was cancelled. Start it again when ready.";
  return undefined;
};

const timeoutUserMessage = (error: AnalysisTimeoutError): string =>
  `REA's ${error.operation} operation reached its ${String(error.timeoutMs)}ms server/provider deadline. This is not a client-side timeout; extending only the MCP client's deadline does not change this budget.`;

const timeoutRemediation = (error: AnalysisTimeoutError): string =>
  `Inspect any partial Evidence, provider diagnostics and reported session/provider cleanup state for ${error.operation}. Reduce the request if supported, or resolve the reported provider condition before retrying. Do not repeat the unchanged call or retry while work or cleanup may still be active.`;

const UNREADABLE_OUTPUT_TAGS: ReadonlySet<string> = new Set<AnalysisErrorTag>([
  "AnalysisProtocolError",
  "AnalysisOutputError",
]);
const UNSUPPORTED_PROVIDER_TAGS: ReadonlySet<string> =
  new Set<AnalysisErrorTag>([
    "AnalysisCapabilityUnavailableError",
    "ProviderSelectionError",
  ]);
const CANCELLED_TAGS: ReadonlySet<string> = new Set<AnalysisErrorTag>([
  "AnalysisCancelledError",
]);

/** Operations that accept integrity_policy for declared-integrity mismatches. */
const INTEGRITY_POLICY_OPERATIONS: ReadonlySet<
  ArtifactOperationError["operation"]
> = new Set([
  "inventory_artifact",
  "inspect_artifact",
  "extract_artifact",
  "analyze_javascript_application",
]);

const artifactMessage = ({
  operation,
  reason,
  artifactDetails: details,
  detail,
}: ArtifactOperationError): string => {
  if (reason === "cancelled")
    return "Artifact operation was cancelled. Start it again when ready.";
  if (reason === "limit")
    return (
      detail ??
      "Artifact processing reached a resource limit. Select an artifact within the reported limits and retry."
    );
  if (reason === "path")
    return (
      detail ??
      "Artifact contains a conflicting internal path. Inspect the reported path before retrying."
    );
  if (reason === "unavailable" && details?.unpacked === true)
    return `ASAR unpacked companion bytes are unavailable for ${details.logicalPath}. Select the archive in place with its .unpacked directory beside it, then retry.`;
  if (reason === "unavailable")
    return "Artifact processing is unavailable. Review the reported availability reason and resolve that condition before retrying.";
  if (
    reason === "integrity" &&
    details !== undefined &&
    INTEGRITY_POLICY_OPERATIONS.has(operation)
  )
    return `${
      details?.unpacked === true &&
      "calculatedSha256" in details &&
      details.calculatedSha256 !== null
        ? `Declared ASAR integrity for unpacked entry ${details.logicalPath} contradicts its companion file; packaging tools commonly sign or strip unpacked native binaries after writing the archive.`
        : "Artifact bytes contradict declared integrity."
    } If expected, rerun ${operation === "inventory_artifact" ? "inspect_artifact" : operation} with integrity_policy=record-and-continue to retain observed bytes as untrusted; otherwise get a fresh copy.`;
  if (reason === "integrity")
    return "Artifact is invalid or has changed. Get a fresh copy and try again.";
  return "Artifact could not be read or written. Check file access and try again.";
};

const mergeRelatedList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): readonly string[] | undefined => {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])];
  return merged.length === 0 ? undefined : merged;
};

const presentedRelatedInputs = (
  error: AnalysisError,
): AnalysisRelatedInputs | undefined => {
  if (error instanceof BinaryTargetError) {
    if (error.constraint === "directory_requires_file")
      return {
        operations: [
          "inspect_desktop_application",
          "audit_release_exposure",
          "analyze_javascript_application",
        ],
      };
    if (error.remediationAction !== undefined) return undefined;
    if (
      (error.constraint === "bundle_executable_undeclared" ||
        error.constraint === "bundle_program_missing") &&
      error.infoPlist !== undefined
    )
      return { operations: ["inspect_plist"] };
    if (error.constraint === "load_selection_rejected")
      return {
        parameters: [
          "format",
          "architecture",
          "architecture_variant",
          "entry_point",
          "base_address",
          "vector_table_address",
        ],
      };
    if (error.constraint === "wasm_requires_static_inspection")
      return { operations: ["inspect_wasm_artifact"] };
  }
  if (
    error instanceof ArtifactOperationError &&
    error.reason === "integrity" &&
    error.artifactDetails !== undefined &&
    INTEGRITY_POLICY_OPERATIONS.has(error.operation)
  )
    return {
      parameters: ["integrity_policy"],
      ...(error.operation === "inventory_artifact"
        ? { operations: ["inspect_artifact"] }
        : {}),
    };
  return undefined;
};

/**
 * Contract fields and operations that the shared error presentation names for
 * recovery, combined with any producer-bound `error.related`.
 */
export const analysisErrorRelatedInputs = (
  error: AnalysisError,
): AnalysisRelatedInputs | undefined => {
  error = resolvedAnalysisError(error);
  const presented = presentedRelatedInputs(error);
  const parameters = mergeRelatedList(
    error.related?.parameters,
    presented?.parameters,
  );
  const operations = mergeRelatedList(
    error.related?.operations,
    presented?.operations,
  );
  const providers = mergeRelatedList(error.related?.providers, undefined);
  if (
    parameters === undefined &&
    operations === undefined &&
    providers === undefined
  )
    return undefined;
  return {
    ...(parameters === undefined ? {} : { parameters }),
    ...(operations === undefined ? {} : { operations }),
    ...(providers === undefined ? {} : { providers }),
  };
};

const evidenceFileMessage = ({
  operation,
  reason,
  published,
  systemCode,
}: EvidenceFileError): string => {
  if (published !== undefined)
    return "The output file was published, but staging cleanup remains incomplete.";
  if (reason === "path-limit")
    return "Filesystem path-length constraints prevented reading or atomic publication at the selected path. Choose a shorter local path.";
  if (reason === "storage-limit")
    return systemCode === "EFBIG"
      ? "The host file-size limit prevented Evidence publication. Increase the inherited file-size allowance and retry."
      : systemCode === undefined
        ? "A host filesystem resource limit prevented Evidence publication. Check the file-size allowance, filesystem space and quota before retrying."
        : "The filesystem lacks space or quota for Evidence publication. Free space or increase quota and retry.";
  if (reason === "symlink-traversal")
    return "The selected path cannot be resolved because its symbolic-link chain loops or exceeds the host traversal limit. Repair the chain or select another path.";
  if (reason === "missing")
    return operation === "read"
      ? "Evidence file does not exist at the selected path. Check the path and try again."
      : "Evidence output directory does not exist. Choose an existing directory and try again.";
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
  AnalysisTargetFailureError: true,
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
  ConfigurationError: true,
  NoBinaryOpenError: true,
  BinaryTargetError: true,
} as const satisfies Readonly<Record<AnalysisErrorTag, true>>;

/**
 * Accept a domain error the shared tables present, or a provider-owned error
 * that presents itself.
 */
export const assertKnownAnalysisError = (error: AnalysisError): void => {
  if (error instanceof ProviderOwnedAnalysisError) return;
  const tag = domainErrorTag(error);
  if (tag === undefined || KNOWN_ERROR_TAGS[tag] !== true)
    throw new TypeError("Unknown analysis error tag");
};
