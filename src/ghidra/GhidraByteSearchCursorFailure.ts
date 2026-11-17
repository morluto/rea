import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";

/**
 * Bridge code for a schema-valid byte-search cursor whose one-way binding
 * does not match this search. The digest covers the target, analysis
 * profile, pattern, mask, bounds, and document. It does not say which of
 * those differs, so callers must not treat the refusal as proof that the
 * project or target changed.
 */
const GHIDRA_BYTE_SEARCH_CURSOR_MISMATCH = "byte_search_cursor_mismatch";

/** True when the bridge rejected a cursor for a different bound context. */
export const isGhidraByteSearchCursorMismatch = (
  code: string | undefined,
): boolean => code === GHIDRA_BYTE_SEARCH_CURSOR_MISMATCH;

const REMEDIATION =
  "Select the original target, analysis profile or Ghidra project, pattern, mask, bounds, and document. When a saved project was used, start REA with the same REA_GHIDRA_PROJECT_PATH and REA_GHIDRA_PROGRAM_NAME. Or start a new search without the cursor. Do not repeat the unchanged call.";

/**
 * Report the binding mismatch as the headline. The request satisfied its
 * contract, so the projection omits schema-repair recovery and attributes
 * the issue to the cursor. The differing component stays unknown.
 */
export const ghidraByteSearchCursorMismatch = (
  operation: string,
  reason: string,
  options: AnalysisErrorOptions,
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    {
      ...options,
      userMessage: `${reason.trim().replace(/\.$/u, "")}.`,
      remediationAction: REMEDIATION,
      conformsToInputContract: true,
    },
    [
      {
        path: ["cursor"],
        reason: "invalid_value",
        message: reason,
        observed: {
          differing_component: "unknown",
          bound_to: [
            "target",
            "analysis_profile",
            "pattern",
            "mask",
            "bounds",
            "document",
          ],
        },
      },
    ],
  );
