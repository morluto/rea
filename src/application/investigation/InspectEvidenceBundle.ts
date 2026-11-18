import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  inspectEvidenceLinks,
  selectEvidenceRecords,
  summarizeEvidenceBundle,
  type EvidenceBundleSummary,
  type EvidenceLinkInspection,
  type EvidenceRecordFilters,
  type EvidenceRecordSelection,
} from "../../domain/evidenceRecordSummary.js";

type InspectionDetail = "complete" | "summary" | "records" | "links";

/** Fields owned by particular deliveries, refused elsewhere rather than ignored. */
const DELIVERY_FIELDS = [
  ["offset", ["records", "links"]],
  ["limit", ["records", "links"]],
  ["traversal", ["links"]],
  ["link_status", ["links"]],
] as const;

/** Select complete delivery, discovery metadata, complete records, or link membership. */
export const inspectEvidenceBundle = (
  bundle: EvidenceBundle,
  options: {
    readonly detail: InspectionDetail;
    readonly filters?: EvidenceRecordFilters | undefined;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
    readonly traversal?: "direct" | "retained-closure" | undefined;
    readonly link_status?: "missing" | "retained" | "all" | undefined;
  },
): Result<
  | EvidenceBundle
  | EvidenceBundleSummary
  | EvidenceRecordSelection
  | EvidenceLinkInspection,
  AnalysisInputError
> => {
  if (options.detail === "complete" && options.filters !== undefined)
    return err(
      new AnalysisInputError("get_evidence_bundle", undefined, [
        {
          path: ["filters"],
          reason: "invalid_value",
          message:
            "Record filters require detail: summary, records or links; complete returns the canonical bundle.",
          expected: "detail: summary, records or links",
        },
      ]),
    );
  const misplaced = DELIVERY_FIELDS.filter(
    ([field, details]) =>
      options[field] !== undefined &&
      !(details as readonly InspectionDetail[]).includes(options.detail),
  );
  if (misplaced.length > 0)
    return err(
      new AnalysisInputError(
        "get_evidence_bundle",
        undefined,
        misplaced.map(([field, details]) => {
          const expected = details
            .map((detail) => `detail: ${detail}`)
            .join(" or ");
          return {
            path: [field],
            reason: "invalid_value" as const,
            message: `${field} requires ${expected}.`,
            expected,
          };
        }),
      ),
    );
  if (options.detail === "records")
    return ok(
      selectEvidenceRecords(bundle, options.filters, {
        offset: options.offset,
        limit: options.limit,
      }),
    );
  if (options.detail === "links")
    return ok(
      inspectEvidenceLinks(bundle, options.filters, {
        traversal: options.traversal,
        linkStatus: options.link_status,
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
