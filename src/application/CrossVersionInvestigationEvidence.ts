import { compareArtifacts } from "../domain/artifactComparison.js";
import { findChangedBehavior } from "../domain/changedBehavior.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import {
  investigationRunSummarySchema,
  type InvestigationRun,
  type InvestigationWorkspace,
} from "../domain/investigationWorkspace.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { AUTOMATIC_RUN_LIMITATION } from "./CrossVersionInventory.js";
import {
  ARTIFACT_COMPARISON_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
} from "./InvestigationProviders.js";

/** Derive deterministic artifact-comparison Evidence from inventory pages. */
export const createArtifactComparisonEvidence = (
  inventory: {
    readonly left: readonly Evidence[];
    readonly right: readonly Evidence[];
  },
  limit: number,
): Evidence => {
  const comparison = compareArtifacts(
    inventory.left,
    inventory.right,
    0,
    limit,
  );
  const leftIds = evidenceIds(inventory.left);
  const rightIds = evidenceIds(inventory.right);
  return createEvidence(undefined, ARTIFACT_COMPARISON_PROVIDER, {
    predicateType: "rea.artifact-comparison/v1",
    operation: "compare_artifacts",
    parameters: {
      left_evidence_ids: leftIds,
      right_evidence_ids: rightIds,
      offset: 0,
      limit,
    },
    result: jsonValueSchema.parse(comparison),
    confidence: "derived",
    authority: "analyst-inference",
    limitations: comparison.limitations,
    evidenceLinks: [...leftIds, ...rightIds],
  });
};

/** Derive the deterministic final report for one comparison checkpoint. */
export const createChangedBehaviorEvidence = (
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
  comparison: Evidence,
): Evidence => {
  const limit = Math.min(run.options.change_limit, 100);
  const changed = findChangedBehavior([comparison], 0, limit);
  const summary = investigationRunSummarySchema.parse({
    schema_version: 1,
    workspace_id: workspace.workspace_id,
    run_id: run.run_id,
    left_manifest_id: run.left.manifest_id,
    right_manifest_id: run.right.manifest_id,
    inventory_evidence_count:
      run.left_inventory_evidence_ids.length +
      run.right_inventory_evidence_ids.length,
    comparison_evidence_id: comparison.evidence_id,
    limitations: run.limitations,
  });
  return createEvidence(undefined, CHANGED_BEHAVIOR_PROVIDER, {
    predicateType: "rea.changed-behavior/v1",
    operation: "find_changed_behavior",
    parameters: {
      workspace_id: workspace.workspace_id,
      run_id: run.run_id,
      comparison_evidence_ids: [comparison.evidence_id],
      offset: 0,
      limit,
    },
    result: jsonValueSchema.parse({
      ...changed,
      investigation_run: summary,
    }),
    confidence: "derived",
    authority: "analyst-inference",
    limitations: [...changed.limitations, AUTOMATIC_RUN_LIMITATION],
    evidenceLinks: changed.evidence_links,
  });
};

const evidenceIds = (records: readonly Evidence[]): string[] =>
  records.map(({ evidence_id: id }) => id);
