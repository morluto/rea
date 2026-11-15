import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "./analysisErrorCore.js";
import type { AnalysisError } from "./analysisErrorBase.js";
import type { AnalysisRefusal } from "./analysisRefusal.js";

/**
 * The typed refusal an error carries, attributed to the error's operation so
 * a re-attributed error names the request that was refused. Occupied capacity
 * keeps its wait-and-retry recovery even when a setting bounds it.
 */
export const analysisErrorRefusal = (
  error: AnalysisError,
): AnalysisRefusal | undefined => {
  if (error instanceof AnalysisResourceConstraintError) {
    if (error.fixedAllowance !== undefined)
      return {
        kind: "fixed_ceiling",
        operation: error.operation,
        ceiling: error.fixedAllowance,
      };
    if (
      error.limit !== undefined &&
      !(
        "measuredExhaustion" in error.recovery &&
        error.recovery.measuredExhaustion === true
      )
    )
      return {
        kind: "adjustable_budget",
        operation: error.operation,
        budget: error.limit,
      };
    return undefined;
  }
  if (
    error instanceof AnalysisInputError &&
    error.ambiguousSelector !== undefined
  )
    return {
      kind: "ambiguous_selector",
      operation: error.operation,
      selector: error.ambiguousSelector,
    };
  return undefined;
};
