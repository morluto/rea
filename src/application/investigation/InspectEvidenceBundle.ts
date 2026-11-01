import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  selectEvidenceRecords,
  summarizeEvidenceBundle,
  type EvidenceBundleSummary,
  type EvidenceRecordFilters,
  type EvidenceRecordSelection,
} from "../../domain/evidenceRecordSummary.js";

/** Select complete bundle delivery, discovery metadata, or a page of complete selected records. */
export const inspectEvidenceBundle = (
  bundle: EvidenceBundle,
  options: {
    readonly detail: "complete" | "summary" | "records";
    readonly filters?: EvidenceRecordFilters | undefined;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
  },
): Result<
  EvidenceBundle | EvidenceBundleSummary | EvidenceRecordSelection,
  AnalysisInputError
> => {
  if (options.detail === "complete" && options.filters !== undefined)
    return err(
      new AnalysisInputError("get_evidence_bundle", undefined, [
        {
          path: ["filters"],
          reason: "invalid_value",
          message:
            "Record filters require detail: summary or records; complete returns the canonical bundle.",
          expected: "detail: summary or records",
        },
      ]),
    );
  if (options.detail !== "records") {
    const paging = (["offset", "limit"] as const).filter(
      (field) => options[field] !== undefined,
    );
    if (paging.length > 0)
      return err(
        new AnalysisInputError(
          "get_evidence_bundle",
          undefined,
          paging.map((field) => ({
            path: [field],
            reason: "invalid_value" as const,
            message: `${field} pages complete records and requires detail: records.`,
            expected: "detail: records",
          })),
        ),
      );
  }
  if (options.detail === "records")
    return ok(
      selectEvidenceRecords(bundle, options.filters, {
        offset: options.offset,
        limit: options.limit,
      }),
    );
  return ok(
    options.detail === "summary"
      ? summarizeEvidenceBundle(bundle, options.filters)
      : bundle,
  );
};
