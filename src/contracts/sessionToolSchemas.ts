import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../domain/localPath.js";
import { bundleComparisonInputSchema } from "../domain/bundleComparison.js";

import { prefixedDigestSchema } from "./../domain/digests.js";
import {
  EVIDENCE_RECORD_SELECTION_LIMIT,
  evidenceRecordFiltersSchema,
} from "../domain/evidenceRecordSummary.js";
import { residualUnknownSchema } from "../domain/residualUnknown.js";

/** Complete retained Evidence, selected discovery metadata, or a page of selected complete records. */
export const getEvidenceBundleInputSchema = z.strictObject({
  detail: z.enum(["complete", "summary", "records"]).default("complete"),
  filters: evidenceRecordFiltersSchema.optional(),
  offset: z
    .int()
    .nonnegative()
    .optional()
    .describe("records only: first matching record to return; default 0."),
  limit: z
    .int()
    .positive()
    .optional()
    .describe(
      `records only: maximum complete records to return; default ${String(EVIDENCE_RECORD_SELECTION_LIMIT)}.`,
    ),
});

/** Optional document selection for volatile navigation context. */
export const navigationContextInputSchema = z.strictObject({
  document: z.string().min(1).optional(),
});

/** Explicit reproducible address context query. */
export const addressContextInputSchema = z.strictObject({
  address: z.string().min(1),
  document: z.string().min(1).optional(),
});

/** Session-owned Evidence bundle import options. */
export const importEvidenceBundleInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute local filesystem path for the evidence bundle to import; relative paths are rejected.",
  ),
});

/** MCP compares files selected on the server host, so require explicit paths. */
export const bundleComparisonMcpInputSchema =
  bundleComparisonInputSchema.extend({
    left_bundle_path: absoluteLocalPathStringSchema.describe(
      "Absolute local filesystem path to the left Evidence bundle.",
    ),
    right_bundle_path: absoluteLocalPathStringSchema.describe(
      "Absolute local filesystem path to the right Evidence bundle.",
    ),
  });

/** Residual-unknown list filters. */
export const listUnknownsInputSchema = z.strictObject({
  status: residualUnknownSchema.shape.status.optional(),
  severity: residualUnknownSchema.shape.severity.optional(),
  domain: residualUnknownSchema.shape.domain.optional(),
  offset: z
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe("Zero-based offset in the stable filtered unknown ID order."),
  limit: z
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "Optional maximum number of heads to return. Omit to return every matching head from offset.",
    ),
});

/** Exact residual-unknown identity to revalidate. */
export const verifyUnknownResolutionInputSchema = z.strictObject({
  unknown_id: prefixedDigestSchema("unk"),
});
