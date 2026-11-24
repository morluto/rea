import type { EvidenceLookup } from "../EvidenceInputResolver.js";
import { resolveEvidenceInput } from "../EvidenceInputResolver.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { artifactInventorySummaryViewResultSchema } from "../../domain/analysisView/summarySchemas/artifactInventorySummarySchema.js";
import {
  EvidenceIntegrityError,
  EvidenceReferenceError,
} from "../../domain/evidenceErrors.js";
import type { Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";

const isArtifactInventoryEvidence = (evidence: Evidence): boolean =>
  evidence.operation === "inspect_artifact" ||
  evidence.operation === "inventory_artifact";

/** Resolve one clustering member, including an artifact summary's exact retained owner or retained Evidence reference. */
export const resolveArtifactFamilyClusteringEvidence = async (
  memberInput: Evidence | string,
  evidenceById: EvidenceLookup | undefined,
  label?: string,
): Promise<Result<Evidence, AnalysisError>> => {
  let evidence: Evidence;
  if (typeof memberInput === "string") {
    const resolvedInput = resolveEvidenceInput(
      { kind: "retained-evidence", evidence_id: memberInput },
      evidenceById,
    );
    if (!resolvedInput.ok) return resolvedInput;
    evidence = resolvedInput.value;
  } else {
    evidence = memberInput;
  }

  if (evidence.operation === "inspect_analysis_view") {
    const summary = artifactInventorySummaryViewResultSchema.safeParse(
      evidence.normalized_result,
    );
    if (!summary.success)
      return err(
        new AnalysisInputError("cluster_artifacts", undefined, [
          {
            path: ["members"],
            reason: "invalid_value",
            message: `Member "${label ?? "unknown"}" is not an artifact inventory summary.`,
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
    if (!isArtifactInventoryEvidence(parent))
      return err(
        new AnalysisInputError("cluster_artifacts", undefined, [
          {
            path: ["members"],
            reason: "invalid_value",
            message: `Member "${label ?? parentId}" parent Evidence has operation ${parent.operation}; artifact family clustering accepts only artifact inventories.`,
          },
        ]),
      );
    const { inspectAnalysisViewValidated } =
      await import("../analysisView/AnalysisViewService.js");
    const reprojected = inspectAnalysisViewValidated(
      {
        source: { kind: "retained-evidence", evidence_id: parentId },
        view: { kind: "summary" },
      },
      (evidenceId) => (evidenceId === parentId ? parent : undefined),
    );
    if (!reprojected.ok) return reprojected;
    if (reprojected.value.evidence_id !== evidence.evidence_id)
      return err(
        new EvidenceIntegrityError(
          `Artifact summary for member "${label ?? evidence.evidence_id}" does not match its retained parent inventory.`,
        ),
      );
    return ok(parent);
  }

  if (!isArtifactInventoryEvidence(evidence)) {
    return err(
      new AnalysisInputError("cluster_artifacts", undefined, [
        {
          path: ["members"],
          reason: "invalid_value",
          message: `Member "${label ?? evidence.evidence_id}" references ${evidence.operation} Evidence; artifact family clustering accepts only artifact inventories.`,
        },
      ]),
    );
  }

  return ok(evidence);
};
