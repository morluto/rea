import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  managedNativeVerificationInputSchema,
  verifyManagedNativeBoundaries,
  type ManagedNativeVerificationInput,
  type ManagedNativeVerificationResult,
} from "../domain/managedNativeVerification.js";
import { err, ok, type Result } from "../domain/result.js";
import { MANAGED_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";

const OPERATION = "verify_managed_native_boundaries" as const;

/** Verify managed/native boundary declarations against native Evidence. */
export const verifyManagedNativeBoundariesEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  const parsed = managedNativeVerificationInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
  try {
    const result = verifyManagedNativeBoundaries(parsed.data);
    return ok(createManagedNativeVerificationEvidence(parsed.data, result));
  } catch (cause: unknown) {
    return err(
      cause instanceof TypeError || cause instanceof z.ZodError
        ? new AnalysisInputError(OPERATION, { cause })
        : new AnalysisProtocolError(
            "Managed/native verification produced an invalid result",
            { cause },
          ),
    );
  }
};

const createManagedNativeVerificationEvidence = (
  input: ManagedNativeVerificationInput,
  result: ManagedNativeVerificationResult,
): Evidence =>
  createEvidence(undefined, MANAGED_WORKFLOW_PROVIDER, {
    predicateType: "rea.managed-native-verification/v1",
    operation: OPERATION,
    parameters: {
      managed_boundaries_evidence_id: input.managed_boundaries.evidence_id,
      native_evidence_ids: jsonValueSchema.parse(
        input.native_observations.map(({ evidence_id: id }) => id),
      ),
      limits: jsonValueSchema.parse(input.limits),
    },
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    evidenceLinks: result.evidence_links,
  });
