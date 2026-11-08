import {
  evidencePayloadValidationIssue,
  MAX_EVIDENCE_JSON_DEPTH,
  MISSING_EVIDENCE_SUBJECT_LIMITATION,
} from "../../domain/evidence.js";
import {
  analysisExecutionEnvelopeForAdmission,
  type AnalysisObservation,
} from "../../domain/analysisObservation.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { err } from "../../domain/result.js";
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
  admit: RecoveryAdmission = (input, name, additional, maximumDepth) =>
    admitInvestigationAuthentication(input, name, {}, additional, maximumDepth),
) => {
  const envelope = analysisExecutionEnvelopeForAdmission(
    operation,
    parameters,
    observation,
    "observed",
  );
  let valueBytes = 0;
  let serializedUtf16Bytes = 0;
  if (observation.subject == null) {
    const entry = estimateJsonArrayScalarEntry(
      MISSING_EVIDENCE_SUBJECT_LIMITATION,
      observation.limitations.length > 0,
    );
    valueBytes += entry.valueBytes;
    serializedUtf16Bytes += entry.serializedUtf16Bytes;
  }
  for (const [index, source] of (observation.sourceEvidence ?? []).entries()) {
    const entry = estimateJsonArrayScalarEntry(source.evidence_id, index > 0);
    valueBytes += entry.valueBytes;
    serializedUtf16Bytes += entry.serializedUtf16Bytes;
  }
  const payloadIssue = evidencePayloadValidationIssue(envelope);
  const admitted =
    payloadIssue === undefined
      ? admit(
          envelope,
          operation,
          {
            valueBytes,
            serializedUtf16Bytes,
          },
          MAX_EVIDENCE_JSON_DEPTH,
        )
      : err(
          new EvidenceIntegrityError(
            "Completed Evidence payload is not ordinary JSON",
            { userMessage: payloadIssue },
          ),
        );
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
