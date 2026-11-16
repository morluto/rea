import type { InvestigationRecords } from "../../src/application/investigation/InvestigationRecords.js";
import type { WorkflowSession } from "../../src/application/SessionWorkflowEvidence.js";
import { ok } from "../../src/domain/result.js";

/**
 * A session for provider-backed workflows that records into `records`, has
 * no active target or analysis profile and never replays workflow snapshots.
 */
export const recordsWorkflowSession = (
  records: InvestigationRecords,
  overrides: Partial<WorkflowSession> = {},
): WorkflowSession => ({
  activeTarget: () => undefined,
  analysisProfile: () => undefined,
  recordEvidence: (evidence) => records.recordEvidence(evidence),
  evidenceForAnalysis: (id) => records.evidenceForAnalysis(id),
  admitRecoveryObservation: (input, operation, additional) =>
    records.admitRecoveryObservation(input, operation, additional),
  recordUnknown: (input) => records.recordUnknown(input),
  allowsSnapshotReplay: () => false,
  recordWorkflowSnapshot: () => ok(null),
  ...overrides,
});
