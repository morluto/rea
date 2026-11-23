import { z } from "zod";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import { nativeFeatureTraceSummarySchema } from "../nativeFeatureTraceView.js";
import { nativeViewSourceContext } from "../nativeViewContext.js";

export const nativeFeatureTraceSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  ...nativeViewSourceContext,
  artifact: artifactSchema.nullable(),
  parent_operation: z.literal("trace_feature"),
  summary: nativeFeatureTraceSummarySchema,
});
