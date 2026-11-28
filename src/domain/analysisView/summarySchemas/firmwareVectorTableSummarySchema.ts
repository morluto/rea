import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { firmwareVectorTableSummarySchema } from "../firmwareVectorTableView.js";

export const firmwareVectorTableSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_firmware_vector_table"),
  summary: firmwareVectorTableSummarySchema,
});
