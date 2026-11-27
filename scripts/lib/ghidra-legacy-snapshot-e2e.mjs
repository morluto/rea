import {
  createAnalysisSnapshotEntry,
  parseAnalysisSnapshot,
  snapshotBinding,
  snapshotTarget,
} from "../../dist/domain/analysisSnapshot.js";
import { createEvidence } from "../../dist/domain/evidence.js";
import { createEvidenceBundle } from "../../dist/domain/evidenceBundle.js";

export function createLegacyGhidraSnapshot({
  nativeTarget,
  observed,
  result,
  legacyProfile,
}) {
  const evidence = createEvidence(nativeTarget, observed.provider, {
    operation: observed.operation,
    parameters: observed.parameters,
    result,
    rawResult: result,
    analysisProfile: legacyProfile,
    limitations: observed.limitations,
    locations: observed.locations,
  });
  const binding = snapshotBinding(legacyProfile);
  const identity = snapshotTarget(nativeTarget);
  return parseAnalysisSnapshot({
    target: identity,
    binding,
    entries: [
      createAnalysisSnapshotEntry({
        target: identity,
        binding,
        operation: observed.operation,
        parameters: observed.parameters,
        execution: {
          result,
          rawResult: result,
          provider: observed.provider,
          analysisProfile: legacyProfile,
          limitations: observed.limitations,
          locations: observed.locations,
          subject: evidence.subject,
        },
      }),
    ],
    workflow_entries: [],
    evidence_bundle: createEvidenceBundle([evidence]),
  });
}
