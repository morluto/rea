import type { AnalysisExecution } from "../AnalysisProvider.js";
import type { Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { equalJsonText } from "../../domain/jsonSerialization.js";

// Proof belongs to the exact object issued by the session. A wrapper that
// copies or transforms the observation cannot carry it forward.
const issued = new WeakMap<AnalysisExecution, Evidence>();

export const bindSessionEvidenceExecution = (
  execution: AnalysisExecution,
  evidence: Evidence,
): AnalysisExecution => {
  if (
    execution.sourceEvidence !== undefined &&
    execution.sourceEvidence.length > 0
  )
    return execution;
  const subject =
    execution.subject === undefined || execution.subject === null
      ? execution.subject
      : Object.freeze({ ...execution.subject });
  const result = Object.freeze({
    ...execution,
    result: evidence.normalized_result,
    rawResult: evidence.raw_result,
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
  return result;
};

export const sessionEvidenceForExecution = (
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
