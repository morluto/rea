import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { dartAotSummarySchema } from "../dartAotView.js";

/** Exact snapshot and pool-coverage carrier for selected AOT delivery. */
export const dartAotSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_dart_aot"),
  summary: dartAotSummarySchema,
});
