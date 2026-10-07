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
      readonly status: "complete" | "partial";
      readonly omittedCount: 0;
    }
  | {
      readonly status: "failed";
      readonly omittedCount: null;
    };

/** Classify whole-file semantic coverage from parser recovery. */
export const semanticCoverage = (
  parserPartial: boolean,
): JavaScriptSemanticCoverage => ({
  status: parserPartial ? "partial" : "complete",
  omittedCount: 0,
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
