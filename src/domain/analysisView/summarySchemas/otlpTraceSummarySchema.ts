import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { otlpTraceSummarySchema } from "../otlpTraceView.js";

export const otlpTraceSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_otlp_trace"),
  summary: otlpTraceSummarySchema,
});
