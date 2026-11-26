import { z } from "zod";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  endpointComparisonViewContextSchema,
  endpointComparisonViewItemsSchema,
  endpointComparisonViewRequestSchema,
} from "../endpointComparisonView.js";

export const endpointComparisonSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: z.null(),
  parent_operation: z.literal("compare_static_and_observed_endpoints"),
  summary: endpointComparisonViewContextSchema,
});

export const endpointComparisonPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  ...endpointComparisonViewContextSchema.shape,
  kind: z.literal("endpoint-comparison"),
  artifact: z.null(),
  parent_operation: z.literal("compare_static_and_observed_endpoints"),
  view: endpointComparisonViewRequestSchema,
  items: endpointComparisonViewItemsSchema,
});
