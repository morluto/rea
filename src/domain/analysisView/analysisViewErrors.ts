import { err, type Result } from "../result.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  type AnalysisInputIssue,
} from "../analysisErrorCore.js";

export const INSPECT_ANALYSIS_VIEW_OPERATION = "inspect_analysis_view" as const;

export const ANALYSIS_VIEW_PAGE_BYTES = 1024 * 1024;

/** Recovery belongs to the view projection, not to the MCP transport. */
export const ANALYSIS_VIEW_PAGE_BUDGET_RECOVERY = {
  retryable: false,
  remediationAction:
    "The 1,048,576-byte analysis-view page allowance is fixed and has no runtime override. For a pageable collection, select fewer fields or a smaller selection; one oversized field may not fit even in a one-row page. If the error includes details.partial_observation, use that complete parent Evidence. Otherwise, read the parent directly from the caller-supplied bundle, or retrieve/export the retained parent in the same MCP session. Reading the parent does not increase the page allowance.",
} as const;

/** Refuse an oversized page while retaining the view's selection and recovery. */
export const analysisViewPageTooLarge = (
  parentEvidenceId: string,
  reason: string,
  {
    remediationAction = ANALYSIS_VIEW_PAGE_BUDGET_RECOVERY.remediationAction,
    ...selection
  }: {
    readonly collection?: string;
    readonly facet?: string;
    readonly remediationAction?: string;
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
      { retryable: false, remediationAction },
    ),
  );

/** Construct a typed input failure for one selected-view constraint. */
export const analysisViewInputError = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputError =>
  new AnalysisInputError(INSPECT_ANALYSIS_VIEW_OPERATION, undefined, issues);

/** A constraint on the selected view as a whole. */
export const invalidAnalysisView = (
  message: string,
): Result<never, AnalysisInputError> =>
  err(
    analysisViewInputError([
      { path: ["view"], reason: "invalid_value", message },
    ]),
  );
