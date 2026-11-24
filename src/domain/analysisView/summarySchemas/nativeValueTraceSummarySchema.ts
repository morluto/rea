import { z } from "zod";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import { nativeValueTraceSummarySchema } from "../nativeValueTraceView.js";

export const nativeValueTraceSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: artifactSchema.nullable(),
  parent_operation: z.literal("trace_native_values"),
  summary: nativeValueTraceSummarySchema,
});
