import {
  analysisExecutionEnvelopeForAdmission,
  type AnalysisObservation,
} from "../../domain/analysisObservation.js";
import { estimateJsonArrayScalarEntry } from "../JsonAuthenticationHeadroom.js";
import {
  admitInvestigationAuthentication,
  type RecoveryAdmission,
} from "./InvestigationRetention.js";

/** Admit borrowed source facts before constructing their completed Evidence. */
export const admitCompletedAnalysis = (
  operation: string,
  parameters: unknown,
  observation: AnalysisObservation,
  admit: RecoveryAdmission = (input, name, additional) =>
    admitInvestigationAuthentication(input, name, {}, additional),
) => {
  const envelope = analysisExecutionEnvelopeForAdmission(
    operation,
    parameters,
    observation,
    "observed",
  );
  let valueBytes = 0;
  let serializedUtf16Bytes = 0;
  for (const [index, source] of (observation.sourceEvidence ?? []).entries()) {
    const entry = estimateJsonArrayScalarEntry(source.evidence_id, index > 0);
    valueBytes += entry.valueBytes;
    serializedUtf16Bytes += entry.serializedUtf16Bytes;
  }
  const admitted = admit(envelope, operation, {
    valueBytes,
    serializedUtf16Bytes,
  });
  if (!admitted.ok)
    admitted.error.retainSourcePublication({
      kind: "omitted",
      reason:
        admitted.error._tag === "AnalysisResourceConstraintError"
          ? "insufficient-authentication-headroom"
          : "recovery-input-invalid",
      source_closure: "not-established",
    });
  return admitted;
};
