import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import {
  reconstructionObligationLedgerInputSchema,
  reconstructionObligationLedgerSchema,
  type ReconstructionObligationLedgerInput,
  type ReconstructionObligationLedger,
} from "../domain/reconstructionObligationLedgerSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";
import { deriveReconstructionObligationCandidates } from "./ReconstructionObligationCandidates.js";
import { evaluateReconstructionObligationLedger } from "./ReconstructionObligationLedgerEvaluation.js";

const OPERATION = "build_reconstruction_obligation_ledger" as const;

/** Parse one portable ledger request for both CLI and MCP adapters. */
export const resolveReconstructionObligationLedgerRequest = (
  input: unknown,
): Result<ReconstructionObligationLedgerInput, AnalysisError> => {
  const parsed = reconstructionObligationLedgerInputSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
};

/** Build the complete deterministic ledger and wrap it in portable Evidence. */
export const buildReconstructionObligationLedgerEvidenceValidated = (
  input: ReconstructionObligationLedgerInput,
): Result<Evidence, AnalysisError> => {
  try {
    const generated = deriveReconstructionObligationCandidates(
      input.evidence_bundle,
      input.reviewed_obligations,
    );
    const ledger = evaluateReconstructionObligationLedger({
      candidates: generated.candidates,
      bundle: input.evidence_bundle,
      manifest: input.manifest,
      generationLimitations: generated.limitations,
    });
    return ok(createLedgerEvidence(input, ledger));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(new AnalysisInputError(OPERATION, { cause }));
    return err(
      new AnalysisProtocolError(
        "Reconstruction obligation ledger generation failed",
        { cause },
      ),
    );
  }
};

const createLedgerEvidence = (
  input: ReconstructionObligationLedgerInput,
  ledger: ReconstructionObligationLedger,
): Evidence => {
  const completeLedger = reconstructionObligationLedgerSchema.parse(ledger);
  return createEvidence(undefined, JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER, {
    predicateType: "rea.reconstruction-obligation-ledger",
    operation: OPERATION,
    parameters: jsonObjectSchema.parse({
      ledger_id: completeLedger.ledger_id,
      closure_digest: completeLedger.closure_digest,
    }),
    result: jsonValueSchema.parse(completeLedger),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: completeLedger.limitations,
    evidenceLinks: completeLedger.evidence_links,
  });
};
