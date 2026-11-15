import { z } from "zod";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import { readEvidenceBundle } from "../domain/evidenceBundle.js";
import { verifyReconstruction } from "../domain/reconstructionVerification.js";
import type { ReconstructionVerificationResult } from "../domain/reconstructionVerificationSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseAnalysisInput } from "./AnalysisInput.js";
import { resolveInvestigationEvidenceClosure } from "./investigation/InvestigationEvidence.js";

const OPERATION = "verify_reconstruction";
const requestEnvelopeSchema = z.strictObject({
  specification: z.unknown().nonoptional(),
  evidence_bundle: z.unknown().nonoptional(),
});

/** Verify a portable request using the same domain owner as session-owned MCP. */
export const verifyReconstructionRequest = (
  rawInput: unknown,
): Result<ReconstructionVerificationResult, AnalysisError> => {
  const request = parseAnalysisInput(
    OPERATION,
    rawInput,
    requestEnvelopeSchema,
  );
  if (!request.ok) return request;
  const bundle = readEvidenceBundle(request.value.evidence_bundle, {
    operation: OPERATION,
    path: ["evidence_bundle"],
    immutable: true,
  });
  if (!bundle.ok) return bundle;
  try {
    const verified = verifyReconstruction(
      request.value.specification,
      bundle.value,
    );
    const records = new Map(
      bundle.value.records.map((record) => [record.evidence_id, record]),
    );
    const closure = resolveInvestigationEvidenceClosure(
      { evidenceForAnalysis: (id) => records.get(id) },
      verified.evidence_links,
    );
    return closure.ok
      ? ok({ ...verified, evidence_links: closure.value })
      : closure;
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
};
