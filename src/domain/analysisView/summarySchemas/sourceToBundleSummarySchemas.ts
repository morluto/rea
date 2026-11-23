import { z } from "zod";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  sourceToBundleViewContextSchema,
  sourceToBundleViewItemsSchema,
  sourceToBundleViewRequestSchema,
} from "../sourceToBundleView.js";

export const sourceToBundleSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: z.null(),
  parent_operation: z.literal("compare_source_to_bundle"),
  summary: sourceToBundleViewContextSchema,
});

export const sourceToBundlePageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  ...sourceToBundleViewContextSchema.shape,
  kind: z.literal("source-to-bundle"),
  artifact: z.null(),
  parent_operation: z.literal("compare_source_to_bundle"),
  view: sourceToBundleViewRequestSchema,
  items: sourceToBundleViewItemsSchema,
});
