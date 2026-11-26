import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { ociImageLayoutSummarySchema } from "../ociImageLayoutView.js";

export const ociImageLayoutSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_oci_image_layout"),
  summary: ociImageLayoutSummarySchema,
});
