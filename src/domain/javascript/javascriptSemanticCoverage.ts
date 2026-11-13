import { semanticResourceLimitFacts } from "./javascriptSemanticResourceLimits.js";
import type { JavaScriptSourceRange } from "./javascriptStaticAnalysisTypes.js";
import type { JavaScriptSemanticResourceLimit } from "./javascriptSemanticValueTypes.js";
import type { ApplicationCoverage } from "./javascriptApplicationEvidenceSchemas.js";
import {
  JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
  type JavaScriptSemanticPrecision,
} from "./javascriptSemanticPrecision.js";

/** Exact retention state for one callable's direct returns. */
export type JavaScriptSemanticReturnCoverage = {
  readonly retainedCount: number;
} & {
  readonly status: "complete" | "partial";
  readonly omittedCount: 0 | null;
};

/** Coverage state for one semantic recovery pass. */
export type JavaScriptSemanticCoverage =
  | {
      readonly status: "complete";
      readonly omittedCount: 0;
      readonly resourceLimits?: readonly JavaScriptSemanticResourceLimit[];
      readonly precision?: JavaScriptSemanticPrecision;
      readonly widenedReturnedReferences?: readonly JavaScriptSourceRange[];
    }
  | {
      readonly status: "partial";
      readonly omittedCount: 0 | null;
      readonly resourceLimits?: readonly JavaScriptSemanticResourceLimit[];
      readonly precision?: JavaScriptSemanticPrecision;
      readonly widenedReturnedReferences?: readonly JavaScriptSourceRange[];
    }
  | {
      readonly status: "failed";
      readonly omittedCount: null;
      readonly resourceLimits?: readonly JavaScriptSemanticResourceLimit[];
      readonly precision?: JavaScriptSemanticPrecision;
      readonly widenedReturnedReferences?: readonly JavaScriptSourceRange[];
    };

/** Source-local effect candidates broadened at a projection merge, without dropping targets. */
export const RETURNED_REFERENCE_WIDENING_LIMITATION =
  "Local returned-reference projections were conservatively widened; effects include additional source-local candidates.";

/** Classify whole-file semantic coverage from parsing, value bounds and widened projections. */
export const semanticCoverage = (
  parserPartial: boolean,
  resourceLimits: readonly JavaScriptSemanticResourceLimit[] = [],
  widenedReturnedReferences: readonly JavaScriptSourceRange[] = [],
  precision: JavaScriptSemanticPrecision = JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
): JavaScriptSemanticCoverage => {
  const details = {
    ...(widenedReturnedReferences.length > 0
      ? { widenedReturnedReferences }
      : {}),
    ...(precision === JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS
      ? {}
      : { precision }),
  };
  if (resourceLimits.length > 0)
    return {
      status: "partial",
      omittedCount: null,
      resourceLimits,
      ...details,
    };
  return {
    status:
      parserPartial || widenedReturnedReferences.length > 0
        ? "partial"
        : "complete",
    omittedCount: 0,
    ...details,
  };
};

/** Read typed resource-limit classifications from any coverage state. */
export const semanticCoverageResourceLimits = (
  coverage: JavaScriptSemanticCoverage,
): readonly JavaScriptSemanticResourceLimit[] => coverage.resourceLimits ?? [];

/** Effective evaluator facts, rather than reconstructed default-only bounds. */
export const semanticResourceLimitCoverage = (
  resourceLimits: readonly JavaScriptSemanticResourceLimit[],
  precision: JavaScriptSemanticPrecision = JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
): ApplicationCoverage["limits"] =>
  resourceLimits.map((resourceLimit) => {
    const { value, unit } = semanticResourceLimitFacts(
      resourceLimit,
      precision,
    );
    return {
      name: `javascript_semantic_${resourceLimit.replaceAll("-", "_")}`,
      value,
      unit,
    };
  });

/** Classify one callable's direct-return coverage. */
export const semanticReturnCoverage = (
  retainedCount: number,
  parserPartial: boolean,
): JavaScriptSemanticReturnCoverage => ({
  status: parserPartial ? "partial" : "complete",
  retainedCount,
  omittedCount: 0,
});
