import { z } from "zod";
import {
  apkSignatureViewItemsSchema,
  apkSignatureViewRequestSchema,
} from "../../apkSignature/apkSignatureQuery.js";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  apkSignatureSourceCoverageSchema,
  apkSignatureSummarySchema,
} from "../apkSignatureView.js";

export const apkSignatureSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_apk_signature"),
  summary: apkSignatureSummarySchema,
});

export const apkSignaturePageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("apk-signature"),
  parent_operation: z.literal("inspect_apk_signature"),
  view: apkSignatureViewRequestSchema,
  items: apkSignatureViewItemsSchema,
  source_coverage: apkSignatureSourceCoverageSchema,
});
