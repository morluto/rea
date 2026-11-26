import type { BinaryResourceFailure } from "../domain/binaryContainer.js";
import type { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { nativeStructureLimit } from "../domain/native/nativeStructureBudget.js";
import { parseLimitConstraint } from "../domain/parseFailureAnalysisError.js";

/**
 * The refusal of a native table read above `max_structure_bytes`. The
 * failure carries the value its reader enforced, so the limit reports what
 * stopped this call.
 */
export const nativeStructureConstraint = (
  operation: string,
  failure: BinaryResourceFailure,
  path?: string,
): AnalysisResourceConstraintError =>
  parseLimitConstraint(operation, "memory", failure, {
    ...(path === undefined ? {} : { path }),
    retryable: false,
    limit: nativeStructureLimit(failure.maximum_bytes),
  });
