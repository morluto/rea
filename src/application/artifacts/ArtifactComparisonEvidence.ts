import {
  resolveEvidenceInput,
  resolveEvidenceSource,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import type { z } from "zod";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { inspectAnalysisViewValidated } from "../analysisView/AnalysisViewService.js";
import type { EvidenceFileReadOptions } from "../analysisView/evidenceFileSource.js";
import {
  artifactComparisonInputSchema,
  type artifactPathSourceSchema,
} from "../../contracts/artifactComparisonContracts.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { artifactInventorySummaryViewResultSchema } from "../../domain/analysisView/summarySchemas/artifactInventorySummarySchema.js";
import {
  compareArtifacts,
  type ArtifactComparisonResult,
} from "../../domain/artifactComparison.js";
import { readArtifactInspectionSources } from "../../domain/artifactInspection.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "../../domain/comparisonEvidenceIdentity.js";
import {
  EvidenceIntegrityError,
  EvidenceReferenceError,
} from "../../domain/evidenceErrors.js";
import {
  createEvidence,
  evidenceSubjectTarget,
  evidenceTargetIdentity,
  rebindEvidenceToTargetPath,
  type Evidence,
} from "../../domain/evidence.js";
import { readEvidence } from "../../domain/evidenceValidation.js";
import { RECREATE_EVIDENCE_GUIDANCE } from "../../domain/evidenceFormat.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  sameTargetIdentity,
  unknownTarget,
} from "../../domain/targetIdentity.js";
import type { RecordUnknownInput } from "../../domain/residualUnknown.js";
import type { InvestigationWorkflowExecution } from "../investigation/InvestigationWorkflows.js";

const OPERATION = "compare_artifacts";

/** Both comparison sides, each resolved to its exact complete inventory owner. */
export interface ArtifactComparisonSources {
  readonly left: Evidence;
  readonly right: Evidence;
  /**
   * Authenticated source records reachable from `left` and `right`, including
   * nested `inspect_artifact` inventories and linked records from input bundles
   * or the session ledger.
   */
  readonly sourceEvidence?: readonly Evidence[];
}

/** A completed comparison and the derived Evidence citing both complete inputs. */
export interface ArtifactComparisonOutcome {
  readonly comparison: ArtifactComparisonResult;
  readonly evidence: Evidence;
}

/** A caller-selected path inventoried in place for one comparison side. */
export type ArtifactPathSource = z.output<typeof artifactPathSourceSchema>;

/** How a comparison reads its sources: Evidence files, and paths to inventory. */
export interface ArtifactComparisonSourceOptions extends EvidenceFileReadOptions {
  /**
   * Inventory a selected path and return its complete inventory Evidence.
   * Absent, path sources are refused.
   */
  readonly inventoryPath?: (
    source: ArtifactPathSource,
    signal: AbortSignal | undefined,
  ) => Promise<Result<Evidence, AnalysisError>>;
}

/**
 * Select both sides: inventory a path in place, or authenticate Evidence
 * through the shared source owner and resolve a summary to its exact
 * retained parent inventory.
 */
export const resolveArtifactComparisonSources = async (
  input: unknown,
  evidenceById: EvidenceLookup | undefined,
  options: ArtifactComparisonSourceOptions = {},
): Promise<Result<ArtifactComparisonSources, AnalysisError>> => {
  const request = parseAnalysisInput(
    OPERATION,
    input,
    artifactComparisonInputSchema,
    options.signal,
  );
  if (!request.ok) return request;
  const resolveSide = async (
    side: "left" | "right",
  ): Promise<
    Result<
      { readonly evidence: Evidence; readonly sources: readonly Evidence[] },
      AnalysisError
    >
  > => {
    const source = request.value[side];
    if ("kind" in source && source.kind === "path") {
      if (options.inventoryPath === undefined)
        return err(
          new AnalysisInputError(OPERATION, undefined, [
            {
              path: [side, "kind"],
              reason: "invalid_value",
              message:
                "This adapter cannot inventory a path source; supply inventory Evidence instead.",
            },
          ]),
        );
      const inventoried = await options.inventoryPath(source, options.signal);
      return inventoried.ok
        ? ok({
            evidence: inventoried.value,
            sources: collectLinkedSources(inventoried.value, evidenceById),
          })
        : inventoried;
    }
    let linkedSources: readonly Evidence[] = [];
    const resolved = await resolveEvidenceSource(source, side, evidenceById, {
      ...options,
      operation: OPERATION,
      resolveEvidence: (candidate, related) => {
        const authenticated = readEvidence(candidate);
        if (!authenticated.ok) return authenticated;
        const owner = resolveArtifactComparisonEvidence(
          authenticated.value,
          related,
          [side],
        );
        if (!owner.ok) return owner;
        linkedSources = collectLinkedSources(owner.value, related);
        return owner;
      },
    });
    return resolved.ok
      ? ok({ evidence: resolved.value, sources: linkedSources })
      : resolved;
  };
  const left = await resolveSide("left");
  if (!left.ok) return left;
  const right = await resolveSide("right");
  // The completed left inventory survives the right side's failure.
  if (!right.ok)
    return err(
      right.error.retainArgumentObservation("left", left.value.evidence),
    );
  return ok({
    left: left.value.evidence,
    right: right.value.evidence,
    sourceEvidence: deduplicateEvidence([
      ...left.value.sources,
      ...right.value.sources,
    ]),
  });
};

/**
 * The complete source closure for a comparison: every linked record collected
 * for `left` and `right` (including nested `inspect_artifact` inventories),
 * dependencies before dependents and deduplicated by `evidence_id`.
 */
export const artifactComparisonSourceEvidence = (
  sources: ArtifactComparisonSources,
): readonly Evidence[] =>
  deduplicateEvidence(
    sources.sourceEvidence !== undefined
      ? [...sources.sourceEvidence, sources.left, sources.right]
      : [
          ...collectLinkedSources(sources.left, undefined),
          ...collectLinkedSources(sources.right, undefined),
        ],
  );

/**
 * Collect every authenticated record reachable from `root` via `evidence_links`,
 * preferring exact records from `lookup` (input bundle or ledger) and falling
 * back to nested `inspect_artifact` substep inventories. Dependencies precede
 * the records that cite them.
 */
const collectLinkedSources = (
  root: Evidence,
  lookup: EvidenceLookup | undefined,
): Evidence[] => {
  const visited = new Set<string>();
  const collected: Evidence[] = [];
  const visit = (record: Evidence): void => {
    if (visited.has(record.evidence_id)) return;
    visited.add(record.evidence_id);
    const embedded =
      record.operation === "inspect_artifact"
        ? readArtifactInspectionSources(record.normalized_result)
        : undefined;
    const embeddedById =
      embedded !== undefined && embedded.ok
        ? new Map(embedded.value.map((source) => [source.evidence_id, source]))
        : undefined;
    for (const linkId of record.evidence_links) {
      if (visited.has(linkId)) continue;
      const linked = lookup?.(linkId) ?? embeddedById?.get(linkId);
      if (linked !== undefined && linked.evidence_id === linkId) visit(linked);
    }
    collected.push(record);
  };
  visit(root);
  return collected;
};

const deduplicateEvidence = (records: readonly Evidence[]): Evidence[] => [
  ...new Map(records.map((record) => [record.evidence_id, record])).values(),
];

/** Compare resolved inventories and derive Evidence citing both complete owners. */
export const compareArtifactEvidence = ({
  left,
  right,
}: ArtifactComparisonSources): Result<
  ArtifactComparisonOutcome,
  AnalysisError
> => {
  let comparison: ArtifactComparisonResult;
  try {
    comparison = compareArtifacts(left, right);
  } catch (cause: unknown) {
    // Typed causes already name the failed constraint; keep their issues.
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
  const leftEvidenceIds = [left.evidence_id];
  const rightEvidenceIds = [right.evidence_id];
  return ok({
    comparison,
    evidence: createEvidence(
      unknownTarget("derived-from-linked-evidence"),
      ARTIFACT_COMPARISON_PROVIDER,
      {
        predicateType: "rea.artifact-comparison",
        operation: OPERATION,
        parameters: {
          left_evidence_ids: leftEvidenceIds,
          right_evidence_ids: rightEvidenceIds,
        },
        result: comparison,
        confidence: "derived",
        authority: "analyst-inference",
        limitations: comparison.limitations,
        evidenceLinks: [...leftEvidenceIds, ...rightEvidenceIds],
      },
    ),
  });
};

/**
 * Resolve an already-authenticated artifact summary's exact retained owner.
 * The caller must authenticate the supplied Evidence before invoking this helper.
 */
export const resolveArtifactComparisonEvidence = (
  evidence: Evidence,
  evidenceById: EvidenceLookup | undefined,
  path: readonly (string | number)[] = [],
): Result<Evidence, AnalysisError> => {
  if (evidence.operation !== "inspect_analysis_view") return ok(evidence);

  const summary = artifactInventorySummaryViewResultSchema.safeParse(
    evidence.normalized_result,
  );
  if (!summary.success)
    return err(
      new AnalysisInputError(OPERATION, undefined, [
        {
          path: [...path],
          reason: "invalid_value",
          message:
            "Artifact comparison accepts only an artifact inventory summary from inspect_analysis_view.",
        },
      ]),
    );

  const parentId = summary.data.parent_evidence_id;
  const parent = evidenceById?.(parentId);
  if (parent === undefined)
    return err(
      new EvidenceReferenceError(parentId, "missing", {
        expected: "retained complete artifact inventory Evidence",
        actual: null,
      }),
    );
  const selected = resolveEvidenceInput(
    { kind: "retained-evidence", evidence_id: parentId },
    () => parent,
  );
  if (!selected.ok) return selected;
  const authenticated = readEvidence(selected.value);
  if (!authenticated.ok) return authenticated;
  const owner = authenticated.value;
  const presentation = summaryPresentation(evidence, owner, summary.data);
  if (presentation === undefined) return mismatch();
  const reprojected = inspectAnalysisViewValidated(
    {
      source: { kind: "retained-evidence", evidence_id: parentId },
      view: { kind: "summary" },
    },
    (evidenceId) => (evidenceId === parentId ? presentation : undefined),
  );
  if (!reprojected.ok) return reprojected;
  // Only the current format's projection identifies the summary; the format
  // owner refuses earlier projections instead of rebuilding them.
  if (reprojected.value.evidence_id !== evidence.evidence_id) return mismatch();
  return ok(owner);
};

/**
 * The owner as the summary presented it. A local owner may be presented at a
 * later caller-selected alias of the same identity. An owner whose identity
 * is unknown, such as a partial directory walk, has no alias to rebind: the
 * exact reprojection alone binds the summary to it.
 */
const summaryPresentation = (
  summary: Evidence,
  owner: Evidence,
  view: { readonly artifact: { readonly path: string } },
): Evidence | undefined => {
  const ownerIdentity = evidenceTargetIdentity(owner);
  if (ownerIdentity?.kind === "unknown") return owner;
  const identity = evidenceTargetIdentity(summary);
  const target = evidenceSubjectTarget(summary.subject);
  if (
    identity === null ||
    ownerIdentity === null ||
    target === undefined ||
    !sameTargetIdentity(identity, ownerIdentity)
  )
    return undefined;
  // The ledger preserves its original display path; summary delivery may use a
  // later caller-selected alias for this same authenticated owner identity.
  // The alias names the whole target, selection included.
  const { name: _name, ...aliasTarget } = target;
  return rebindEvidenceToTargetPath(owner, {
    ...aliasTarget,
    path: view.artifact.path,
  });
};

const mismatch = (): Result<never, EvidenceIntegrityError> =>
  err(
    new EvidenceIntegrityError(
      `Artifact summary does not match its retained parent inventory. A summary from an earlier Evidence format no longer matches. ${RECREATE_EVIDENCE_GUIDANCE}`,
    ),
  );

/**
 * Compare resolved inventories for a session: the derived Evidence, both
 * sources to retain, and the residual question a changed, unknown or
 * truncated comparison leaves.
 */
export const artifactComparisonExecution = (
  sources: ArtifactComparisonSources,
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  const compared = compareArtifactEvidence(sources);
  if (!compared.ok) return compared;
  const { left, right } = sources;
  const { comparison, evidence } = compared.value;
  return ok({
    evidence,
    sources: artifactComparisonSourceEvidence(sources),
    unknown: artifactUnknownInput(
      left,
      right,
      comparison,
      evidence.evidence_id,
    ),
  });
};

const artifactUnknownInput = (
  left: { readonly evidence_id: string },
  right: { readonly evidence_id: string },
  comparison: ArtifactComparisonResult,
  comparisonEvidenceId: string,
): RecordUnknownInput | undefined => {
  const { status } = comparison;
  if (status === "unchanged") return undefined;
  const sourceIds = [...new Set([left.evidence_id, right.evidence_id])];
  // optional-fact-default: legacy absence names no side; content contradictions apply.
  const contradictingIds = comparison.integrity_mismatch_evidence_ids ?? [];
  const contentContradictions =
    status === "changed" && left.evidence_id !== right.evidence_id
      ? [right.evidence_id]
      : [];
  const contradictions =
    contradictingIds.length > 0 ? contradictingIds : contentContradictions;
  return {
    question: `Artifact comparison is ${status} (comparison ${comparisonEvidenceId})`,
    severity:
      status === "unknown" || status === "truncated" ? "high" : "medium",
    domain: "artifact-comparison",
    supporting_evidence_ids: sourceIds.filter(
      (id) => !contradictions.includes(id),
    ),
    contradicting_evidence_ids: contradictions,
    required_authority: "shipped-artifact",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [
      {
        operation: "inspect_artifact",
        rationale: "Inspect both artifacts and compare their complete graphs.",
      },
    ],
    relationships: [],
  };
};
