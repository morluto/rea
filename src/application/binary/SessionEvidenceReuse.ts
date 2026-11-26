import {
  evidenceSubjectDisplay,
  withEvidenceProviderSelection,
  type ProviderSelectionProvenance,
  type Evidence,
} from "../../domain/evidence.js";
import {
  analysisProfilesEqual,
  type AnalysisProfileCommitment,
} from "../../domain/analysisProfile.js";
import type { SessionProviderRoute } from "./SessionProviderRouter.js";
import { selectionProvenanceForRoute } from "./ProviderSelectionProvenance.js";
import { basename } from "node:path";
import {
  immutableJsonSnapshotMember,
  freezeJsonSnapshot,
} from "../../domain/immutableJson.js";
import type { AnalysisExecution } from "../../ports/AnalysisProvider.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { equalJsonText } from "../../domain/jsonSerialization.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createAnalysisExecutionEvidence } from "../../domain/analysisObservation.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { ok, type Result } from "../../domain/result.js";
import { admitCompletedAnalysis } from "../investigation/admitCompletedAnalysis.js";
import type { RecoveryAdmission } from "../investigation/InvestigationRetention.js";

const NATIVE_PROVIDERS = new Set(["hopper", "ghidra", "ida", "kuna"]);
const executionSelections = new WeakMap<
  AnalysisExecution,
  | {
      readonly kind: "fresh";
      readonly providerId: string;
      readonly profile: AnalysisProfileCommitment | null;
      readonly selection: ProviderSelectionProvenance;
    }
  | {
      readonly kind: "replay";
      readonly selection: ProviderSelectionProvenance | undefined;
    }
>();

/** Capture facts from this dispatch's route, never from a later active target. */
export const bindFreshNativeExecution = (
  execution: AnalysisExecution,
  route: SessionProviderRoute,
): AnalysisExecution => {
  const binding = route.binding;
  if (
    binding === null ||
    !NATIVE_PROVIDERS.has(binding.identity.id) ||
    execution.provider.id !== binding.identity.id ||
    (execution.provider.version !== null &&
      binding.identity.version !== null &&
      execution.provider.version !== binding.identity.version) ||
    (execution.analysisProfile !== undefined &&
      route.profile !== null &&
      !analysisProfilesEqual(execution.analysisProfile, route.profile))
  )
    return execution;
  const selection = selectionProvenanceForRoute(route);
  if (selection === undefined) return execution;
  // Own the returned envelope so a provider reusing its result object cannot
  // overwrite the provenance associated with an earlier execution.
  const observed = { ...execution };
  executionSelections.set(observed, {
    kind: "fresh",
    providerId: binding.identity.id,
    profile: route.profile,
    selection: freezeJsonSnapshot(selection),
  });
  return observed;
};

/** Keep the original record's metadata when the snapshot owner authenticates a replay. */
export const bindSnapshotReplayExecution = (
  execution: AnalysisExecution,
  source: Evidence,
): AnalysisExecution => {
  if (execution.evidenceId !== source.evidence_id) return execution;
  executionSelections.set(execution, {
    kind: "replay",
    selection: source.provider_selection,
  });
  return execution;
};

/** Carry provenance only across an owner-controlled execution projection. */
export const carrySessionExecutionProvenance = <
  Execution extends AnalysisExecution,
>(
  source: AnalysisExecution,
  projected: Execution,
): Execution => {
  const selection = executionSelections.get(source);
  if (selection !== undefined) executionSelections.set(projected, selection);
  return projected;
};

/** Resolve captured metadata against the observation identity at the owning boundary. */
const selectionForObservation = (
  execution: AnalysisExecution,
  providerId: string,
  profile: AnalysisProfileCommitment | null,
): ProviderSelectionProvenance | undefined => {
  const captured = executionSelections.get(execution);
  if (captured === undefined) return undefined;
  if (captured.kind === "replay") return captured.selection;
  if (
    providerId !== captured.providerId ||
    (profile !== null &&
      captured.profile !== null &&
      !analysisProfilesEqual(profile, captured.profile))
  )
    return undefined;
  return captured.selection;
};

/** Borrow only the captured metadata that recovery must budget before materialization. */
export const sessionExecutionEvidenceMetadata = (
  execution: AnalysisExecution,
): Readonly<Pick<Evidence, "provider_selection">> => {
  const selection = selectionForObservation(
    execution,
    execution.provider.id,
    execution.analysisProfile ?? null,
  );
  return Object.freeze(
    selection === undefined ? {} : { provider_selection: selection },
  );
};

/** Use captured native dispatch facts or authenticated historical replay metadata. */
export const withSessionExecutionProvenance = (
  execution: AnalysisExecution,
  evidence: Evidence,
): Evidence => {
  if (evidence.provider_selection !== undefined) return evidence;
  const selection = selectionForObservation(
    execution,
    evidence.provider.id,
    evidence.analysis_profile,
  );
  return selection === undefined
    ? evidence
    : withEvidenceProviderSelection(evidence, selection);
};

// Proof belongs to the exact object issued by the session. A wrapper that
// copies or transforms the observation cannot carry it forward.
const issued = new WeakMap<AnalysisExecution, Evidence>();

export const bindSessionEvidenceExecution = (
  execution: AnalysisExecution,
  evidence: Evidence,
  callerInputPath: string | undefined,
): AnalysisExecution => {
  // A sourced execution reuses its record only when that record links exactly
  // the sources the execution carries, in order, so the reused Evidence keeps
  // its authenticated provenance.
  const sources = execution.sourceEvidence ?? [];
  if (
    sources.length !== evidence.evidence_links.length ||
    sources.some(
      (source, index) => source.evidence_id !== evidence.evidence_links[index],
    ) ||
    evidence.caller_input_path !== callerInputPath
  )
    return execution;
  // Semantic IDs intentionally omit display paths and names. A duplicate in
  // the ledger can therefore refer to the same bytes at a different path.
  const selected = execution.subject;
  const display = evidenceSubjectDisplay(evidence);
  if (
    selected == null
      ? display !== undefined
      : display === undefined ||
        display.local_path !== selected.path ||
        display.name !== (basename(selected.path) || "artifact")
  )
    return execution;
  const subject =
    execution.subject === undefined || execution.subject === null
      ? execution.subject
      : Object.freeze({ ...execution.subject });
  const result = Object.freeze({
    ...execution,
    result:
      immutableJsonSnapshotMember(evidence, "normalized_result") ??
      evidence.normalized_result,
    rawResult:
      immutableJsonSnapshotMember(evidence, "raw_result") ??
      evidence.raw_result,
    provider: evidence.provider,
    ...(evidence.analysis_profile === null
      ? {}
      : { analysisProfile: evidence.analysis_profile }),
    limitations: evidence.limitations,
    locations: evidence.locations,
    ...(evidence.relationship_coverage === null
      ? {}
      : { relationshipCoverage: evidence.relationship_coverage }),
    ...(subject === undefined ? {} : { subject }),
  });
  issued.set(result, evidence);
  return carrySessionExecutionProvenance(execution, result);
};

const sessionEvidenceForExecution = (
  execution: AnalysisExecution,
  operation: string,
  parameters: Readonly<Record<string, JsonValue>>,
  lookup: (id: string) => Evidence | undefined,
): Evidence | undefined => {
  const evidence = issued.get(execution);
  if (
    evidence === undefined ||
    evidence.operation !== operation ||
    lookup(evidence.evidence_id) !== evidence ||
    !equalJsonText(evidence.parameters, parameters)
  )
    return undefined;
  return evidence;
};

/** How one completed session execution becomes Evidence. */
export interface CompletedOperationEvidenceOptions {
  /** The subject when the provider names none. */
  readonly target: BinaryTarget | null;
  readonly admitRecovery?: RecoveryAdmission | undefined;
  /** The session's records, to reuse the record it issued for this call. */
  readonly evidenceById?: ((id: string) => Evidence | undefined) | undefined;
}

/**
 * The Evidence of one completed provider operation, built once for every
 * adapter: the record the session issued for this exact execution and
 * parameters when it holds one, else a new record admitted against the
 * completed analysis.
 */
export const completedOperationEvidence = (
  operation: string,
  parameters: Readonly<Record<string, JsonValue>>,
  execution: AnalysisExecution,
  options: CompletedOperationEvidenceOptions,
): Result<Evidence, AnalysisError> => {
  const reusable =
    options.evidenceById === undefined
      ? undefined
      : sessionEvidenceForExecution(
          execution,
          operation,
          parameters,
          options.evidenceById,
        );
  if (reusable !== undefined) return ok(reusable);
  const observation = {
    ...execution,
    subject:
      execution.subject === undefined ? options.target : execution.subject,
  };
  const admitted = admitCompletedAnalysis(operation, parameters, observation, {
    callerTarget: options.target,
    metadata: sessionExecutionEvidenceMetadata(execution),
    admit: options.admitRecovery,
  });
  if (!admitted.ok) return admitted;
  return ok(
    withSessionExecutionProvenance(
      execution,
      createAnalysisExecutionEvidence(
        operation,
        parameters,
        observation,
        "observed",
        { callerTarget: options.target, immutable: true },
      ),
    ),
  );
};
