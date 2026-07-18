import type { Evidence } from "../domain/evidence.js";
import type {
  InvestigationRun,
  InvestigationWorkspace,
} from "../domain/investigationWorkspace.js";

export const recordsForInvestigationRun = (
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
): Evidence[] => {
  const ids = new Set([
    ...run.left_inventory_evidence_ids,
    ...run.right_inventory_evidence_ids,
    ...(run.comparison_evidence_id === null
      ? []
      : [run.comparison_evidence_id]),
    ...(run.result_evidence_id === null ? [] : [run.result_evidence_id]),
  ]);
  return workspace.bundle.records.filter(({ evidence_id: id }) => ids.has(id));
};

export const mergeInvestigationEvidence = (
  current: readonly Evidence[],
  additions: readonly Evidence[],
): Evidence[] => {
  const records = new Map(
    current.map((record) => [record.evidence_id, record]),
  );
  for (const record of additions)
    if (!records.has(record.evidence_id))
      records.set(record.evidence_id, record);
  return [...records.values()];
};

export const replaceInvestigationRun = (
  runs: readonly InvestigationRun[],
  replacement: InvestigationRun,
): InvestigationRun[] => [
  ...runs.filter(({ run_id: id }) => id !== replacement.run_id),
  replacement,
];

export const investigationEvidenceIds = (
  records: readonly Evidence[],
): string[] => records.map(({ evidence_id: id }) => id);
