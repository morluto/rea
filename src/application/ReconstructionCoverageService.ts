import { z } from "zod";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import {
  evaluateReconstructionClosure,
  reconstructionCoverageDataSchema,
} from "../domain/reconstructionCoverage.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

export const reconstructionCoverageEvaluationInputSchema = z.strictObject({
  coverage: reconstructionCoverageDataSchema,
  boundary_id: z.string().min(1),
});

/** Evaluate inline reconstruction coverage against a named boundary. */
export const evaluateReconstructionCoverage = (
  rawInput: unknown,
  nowEpochMs = Date.now(),
): Result<JsonValue, AnalysisError> => {
  const parsed =
    reconstructionCoverageEvaluationInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError("evaluate_reconstruction_coverage", {
        cause: parsed.error,
      }),
    );
  try {
    return ok(
      jsonValueSchema.parse(
        evaluateReconstructionClosure(
          parsed.data.coverage,
          parsed.data.boundary_id,
          nowEpochMs,
        ),
      ),
    );
  } catch (cause: unknown) {
    return err(
      new AnalysisInputError("evaluate_reconstruction_coverage", { cause }),
    );
  }
};
