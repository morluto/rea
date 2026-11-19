import { z } from "zod";

import {
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
} from "./analysisResourceLimits.js";
import {
  analysisSettingLimit,
  analysisSettingLimitSchema,
} from "./analysisSettingDefinitions.js";

/** Launch-environment seed for the per-script literal candidate ceiling. */
export const WEB_BUNDLE_ENDPOINT_LITERAL_SETTING =
  "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES" as const;
/** Runtime id accepted by `update_analysis_settings`. */
export const WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID =
  "web.bundle_endpoint_literal_candidates" as const;
/** Limitation code a result carries when candidates were omitted. */
export const WEB_BUNDLE_ENDPOINT_LITERAL_CODE =
  "web_bundle_endpoint_literal_candidates" as const;

/** Effective per-script ceiling and where that value came from. */
export interface WebBundleEndpointLiteralAdmission {
  readonly maximumCount: number;
  readonly source: "default" | "setting" | "runtime";
}

export const DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_ADMISSION: WebBundleEndpointLiteralAdmission =
  {
    maximumCount: DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    source: "default",
  };

/** The admission as the parent process sends it to a worker. */
export const webBundleEndpointLiteralAdmissionSchema = z.strictObject({
  maximum_count: z
    .number()
    .int()
    .min(MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES)
    .max(MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES),
  source: z.enum(["default", "setting", "runtime"]),
});

/**
 * What a script result records when literal path/URL candidates did not all
 * fit. `omitted_count` is always positive, so a result that kept everything
 * carries no record at all.
 */
export const webBundleEndpointLiteralRecordSchema = z.strictObject({
  coverage: z.literal("partial"),
  code: z.literal(WEB_BUNDLE_ENDPOINT_LITERAL_CODE),
  admitted_count: z.number().int().nonnegative(),
  /** Unique literals the per-script ceiling dropped. */
  omitted_by_count: z.number().int().nonnegative(),
  /** False when the scan stopped counting at the ceiling. */
  omitted_by_count_exact: z.boolean(),
  /** Literals dropped because the serialized result would exceed its budget. */
  omitted_by_result_budget: z.number().int().nonnegative(),
  omitted_count: z.number().int().positive(),
  /** `maximal` means no accepted setting value can admit the omitted literals. */
  ceiling: z.enum(["adjustable", "maximal"]),
  limit: analysisSettingLimitSchema,
});
export type WebBundleEndpointLiteralRecord = z.infer<
  typeof webBundleEndpointLiteralRecordSchema
>;

/** Which candidates this script did not receive, and why. */
export interface WebBundleEndpointLiteralOmission {
  /** Unique literals the per-script ceiling dropped. */
  readonly byCount: number;
  /** False when the scan stopped counting at the ceiling. */
  readonly byCountExact: boolean;
  /** Literals dropped because the serialized result would exceed its budget. */
  readonly byResultBudget?: number;
}

/** The record for one script, or nothing when every candidate was retained. */
export const webBundleEndpointLiteralRecord = (
  admission: WebBundleEndpointLiteralAdmission,
  admittedCount: number,
  omission: WebBundleEndpointLiteralOmission,
): WebBundleEndpointLiteralRecord | undefined => {
  const omittedByCount = omission.byCount;
  const omittedByCountExact = omission.byCountExact;
  const omittedByResultBudget = omission.byResultBudget ?? 0;
  const omittedCount = omittedByCount + omittedByResultBudget;
  if (omittedCount === 0) return undefined;
  return {
    coverage: "partial",
    code: WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
    admitted_count: admittedCount,
    omitted_by_count: omittedByCount,
    omitted_by_count_exact: omittedByCountExact,
    omitted_by_result_budget: omittedByResultBudget,
    omitted_count: omittedCount,
    ceiling:
      admission.maximumCount >= MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES
        ? "maximal"
        : "adjustable",
    limit: analysisSettingLimit(
      WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
      admission.maximumCount,
      admission.source,
    ),
  };
};

/**
 * Name the ceiling, where it came from, the range, and the recovery. A byte
 * omission and a count omission need different answers, so they are stated
 * separately.
 */
export const webBundleEndpointLiteralRecordMessage = (
  record: WebBundleEndpointLiteralRecord,
): string =>
  [
    `Retained ${String(record.admitted_count)} literal path/URL endpoint candidates and omitted ${String(record.omitted_count)}.`,
    record.omitted_by_count > 0 && record.ceiling === "maximal"
      ? `${record.limit.setting} is already at its maximum of ${String(record.limit.maximum)}. No accepted value reveals the ${record.omitted_by_count_exact ? "omitted literals" : "remaining literals"}. Use the retained candidates and the captured script.`
      : record.omitted_by_count > 0
        ? `Call update_analysis_settings with setting ${record.limit.setting}, action set, and a value from ${String(record.limit.minimum)} to ${String(record.limit.maximum)} for the next analysis; for a CLI run or a future REA process set ${WEB_BUNDLE_ENDPOINT_LITERAL_SETTING} instead.`
        : "",
    record.omitted_by_result_budget > 0
      ? `The other ${String(record.omitted_by_result_budget)} literals were dropped because the per-script result would have exceeded its byte budget; raising the candidate count does not recover them.`
      : "",
    record.omitted_by_count > 0 && !record.omitted_by_count_exact
      ? "The omitted count is not a unique count: the scan stopped counting distinct literals at the ceiling."
      : "",
    "This setting does not raise the worker result budget.",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
