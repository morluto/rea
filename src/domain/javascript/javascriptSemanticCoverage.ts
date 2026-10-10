import type { JavaScriptSemanticResourceLimit } from "./javascriptSemanticValueTypes.js";
import type { ApplicationCoverage } from "./javascriptApplicationEvidenceSchemas.js";
import {
  SEMANTIC_EXPRESSION_DEPTH_LIMIT,
  SEMANTIC_MODULE_SOURCE_BYTES_LIMIT,
  SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT,
  SEMANTIC_PRIMITIVE_JSON_BYTES_LIMIT,
} from "./javascriptSemanticResourceLimits.js";

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
    }
  | {
      readonly status: "partial";
      readonly omittedCount: 0 | null;
      readonly resourceLimits?: readonly JavaScriptSemanticResourceLimit[];
    }
  | {
      readonly status: "failed";
      readonly omittedCount: null;
      readonly resourceLimits?: readonly JavaScriptSemanticResourceLimit[];
    };

/** Classify whole-file semantic coverage from parsing and value bounds. */
export const semanticCoverage = (
  parserPartial: boolean,
  resourceLimits: readonly JavaScriptSemanticResourceLimit[] = [],
): JavaScriptSemanticCoverage =>
  resourceLimits.length > 0
    ? { status: "partial", omittedCount: null, resourceLimits }
    : { status: parserPartial ? "partial" : "complete", omittedCount: 0 };

/** Read typed resource-limit classifications from any coverage state. */
export const semanticCoverageResourceLimits = (
  coverage: JavaScriptSemanticCoverage,
): readonly JavaScriptSemanticResourceLimit[] => coverage.resourceLimits ?? [];

const semanticResourceBounds: Record<
  JavaScriptSemanticResourceLimit,
  Pick<ApplicationCoverage["limits"][number], "value" | "unit">
> = {
  "primitive-candidates": {
    value: SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT,
    unit: "items",
  },
  "primitive-bytes": {
    value: SEMANTIC_PRIMITIVE_JSON_BYTES_LIMIT,
    unit: "bytes",
  },
  "expression-depth": {
    value: SEMANTIC_EXPRESSION_DEPTH_LIMIT,
    unit: "depth",
  },
  "module-source-bytes": {
    value: SEMANTIC_MODULE_SOURCE_BYTES_LIMIT,
    unit: "bytes",
  },
};

/** Map semantic evaluator bounds to their caller-visible application coverage. */
export const semanticResourceLimitCoverage = (
  resourceLimits: readonly JavaScriptSemanticResourceLimit[],
): ApplicationCoverage["limits"] =>
  resourceLimits.map((resourceLimit) => ({
    name: `javascript_semantic_${resourceLimit.replaceAll("-", "_")}`,
    ...semanticResourceBounds[resourceLimit],
  }));

/** Classify one callable's direct-return coverage. */
export const semanticReturnCoverage = (
  retainedCount: number,
  parserPartial: boolean,
): JavaScriptSemanticReturnCoverage => ({
  status: parserPartial ? "partial" : "complete",
  retainedCount,
  omittedCount: 0,
});
