import { z } from "zod";

import { reconstructionCoverageEvaluationInputSchema } from "../domain/reconstructionCoverageInput.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { evaluateReconstructionClosure } from "../domain/reconstructionCoverage.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { requestInputError, workflowInputError } from "./workflowInputError.js";

const OPERATION = "evaluate_reconstruction_coverage";

/** Evaluate inline reconstruction coverage against a named boundary. */
export const evaluateReconstructionCoverage = (
  rawInput: unknown,
  nowEpochMs = Date.now(),
): Result<JsonValue, AnalysisError> => {
  const parsed =
    reconstructionCoverageEvaluationInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(requestInputError(OPERATION, parsed.error, rawInput));
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
      cause instanceof TypeError || cause instanceof z.ZodError
        ? workflowInputError(OPERATION, cause)
        : new AnalysisInputError(OPERATION, { cause }),
    );
  }
};
