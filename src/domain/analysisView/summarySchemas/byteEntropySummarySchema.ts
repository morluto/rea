import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { byteEntropySummarySchema } from "../byteEntropyView.js";

export const byteEntropySummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  summary: byteEntropySummarySchema,
  parent_operation: z.literal("inspect_byte_entropy"),
});
