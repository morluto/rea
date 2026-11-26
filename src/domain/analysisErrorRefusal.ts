import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "./analysisErrorCore.js";
import type { AnalysisError } from "./analysisErrorBase.js";
import type { AnalysisRefusal } from "./analysisRefusal.js";
import { ArtifactOperationError } from "./artifactOperationError.js";

/**
 * The typed refusal an error carries, attributed to the error's operation so
 * a re-attributed error names the request that was refused. A registered
 * setting and a per-call parameter are adjustable budgets; an environment
 * control is not. Occupied capacity keeps its wait-and-retry recovery even
 * when a setting bounds it.
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
    const { limit } = error;
    if (
      limit !== undefined &&
      (!("control_kind" in limit) || limit.control_kind === "parameter") &&
      !(
        "measuredExhaustion" in error.recovery &&
        error.recovery.measuredExhaustion === true
      )
    )
      return {
        kind: "adjustable_budget",
        operation: error.operation,
        budget: limit,
      };
    return undefined;
  }
  if (
    error instanceof ArtifactOperationError &&
    error.fixedAllowance !== undefined
  )
    return {
      kind: "fixed_ceiling",
      operation: error.operation,
      ceiling: error.fixedAllowance,
    };
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
