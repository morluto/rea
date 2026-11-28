import { err, type Result } from "../result.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  type AnalysisInputIssue,
} from "../analysisErrorCore.js";
import { fixedAllowanceOptions } from "../fixedAllowanceRemediation.js";

export const INSPECT_ANALYSIS_VIEW_OPERATION = "inspect_analysis_view" as const;

export const ANALYSIS_VIEW_PAGE_BYTES = 1024 * 1024;

export const ANALYSIS_VIEW_PAGE_ALLOWANCE =
  "The 1,048,576-byte analysis-view page allowance";

const ANALYSIS_VIEW_PAGE_NARROWING =
  "For a pageable collection, select fewer fields or a smaller selection; if the error includes details.partial_observation, use that complete parent Evidence, or read or export the parent from its local bundle or retained MCP session.";

/** Recovery belongs to the view projection, not to the MCP transport. */
export const ANALYSIS_VIEW_PAGE_BUDGET_RECOVERY = fixedAllowanceOptions(
  ANALYSIS_VIEW_PAGE_ALLOWANCE,
  "report",
  {
    limit: ANALYSIS_VIEW_PAGE_BYTES,
    unit: "bytes",
    narrowing: ANALYSIS_VIEW_PAGE_NARROWING,
  },
);

/** Refuse an oversized page while retaining the view's selection and recovery. */
export const analysisViewPageTooLarge = (
  parentEvidenceId: string,
  reason: string,
  {
    narrowing = ANALYSIS_VIEW_PAGE_NARROWING,
    ...selection
  }: {
    readonly collection?: string;
    readonly facet?: string;
    readonly narrowing?: string;
  } = {},
): Result<never, AnalysisResourceConstraintError> =>
  err(
    new AnalysisResourceConstraintError(
      INSPECT_ANALYSIS_VIEW_OPERATION,
      "transport",
      reason,
      {
        parent_evidence_id: parentEvidenceId,
        limit_bytes: ANALYSIS_VIEW_PAGE_BYTES,
        ...selection,
      },
      fixedAllowanceOptions(ANALYSIS_VIEW_PAGE_ALLOWANCE, "report", {
        limit: ANALYSIS_VIEW_PAGE_BYTES,
        unit: "bytes",
        narrowing,
      }),
    ),
  );

/** Construct a typed input failure for one selected-view constraint. */
export const analysisViewInputError = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputError =>
  new AnalysisInputError(INSPECT_ANALYSIS_VIEW_OPERATION, undefined, issues);

/** An invalid selection or field within the requested view. */
export const invalidAnalysisView = (
  message: string,
  ...fields: string[]
): Result<never, AnalysisInputError> =>
  err(
    analysisViewInputError([
      { path: ["view", ...fields], reason: "invalid_value", message },
    ]),
  );

/** The parent Evidence subject does not identify the artifact required by the view. */
export const invalidAnalysisViewSubject = (
  message: string,
): Result<never, AnalysisInputError> =>
  err(
    analysisViewInputError([
      { path: ["source", "subject"], reason: "invalid_value", message },
    ]),
  );
