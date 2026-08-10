import type { JavaScriptSemanticLimits } from "./javascriptSemanticIr.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import { compareCodePoints } from "./javascriptStaticAnalysisHelpers.js";

/** Exact retention state for one callable's direct returns. */
export type JavaScriptSemanticReturnCoverage = {
  readonly retainedCount: number;
} & (
  | {
      readonly status: "complete";
      readonly omittedCount: 0;
      readonly limitsReached: readonly [];
    }
  | {
      readonly status: "partial";
      readonly omittedCount: 0 | null;
      readonly limitsReached: readonly [];
    }
  | {
      readonly status: "truncated";
      readonly omittedCount: number;
      readonly limitsReached: readonly ["maxReturnSites"];
    }
);

/** Coverage state for one bounded semantic recovery pass. */
export type JavaScriptSemanticCoverage =
  | {
      readonly status: "complete" | "partial";
      readonly omittedCount: 0;
      readonly limitsReached: readonly [];
    }
  | {
      readonly status: "truncated";
      readonly omittedCount: number;
      readonly limitsReached: readonly [
        keyof JavaScriptSemanticLimits,
        ...(keyof JavaScriptSemanticLimits)[],
      ];
    }
  | {
      readonly status: "failed";
      readonly omittedCount: null;
      readonly limitsReached: readonly [];
    };

/** Classify whole-file semantic coverage from parser and limit state. */
export const semanticCoverage = (
  state: JavaScriptSemanticAnalysisState,
  parserPartial: boolean,
): JavaScriptSemanticCoverage => {
  if (state.limitsReached.size === 0)
    return {
      status: parserPartial ? "partial" : "complete",
      omittedCount: 0,
      limitsReached: [],
    };
  const limits = [...state.limitsReached].sort(compareCodePoints);
  const first = limits[0];
  if (first === undefined)
    throw new TypeError("Semantic truncation lost its limiting dimension");
  return {
    status: "truncated",
    omittedCount: state.omittedCount,
    limitsReached: [first, ...limits.slice(1)],
  };
};

/** Classify one callable's direct-return coverage. */
export const semanticReturnCoverage = (
  retainedCount: number,
  omittedCount: number,
  parserPartial: boolean,
): JavaScriptSemanticReturnCoverage =>
  omittedCount > 0
    ? {
        status: "truncated",
        retainedCount,
        omittedCount,
        limitsReached: ["maxReturnSites"],
      }
    : {
        status: parserPartial ? "partial" : "complete",
        retainedCount,
        omittedCount: 0,
        limitsReached: [],
      };
