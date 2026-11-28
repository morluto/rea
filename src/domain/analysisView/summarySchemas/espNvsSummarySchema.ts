import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { espNvsSummarySchema } from "../espNvsView.js";

export const espNvsSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_esp_nvs"),
  summary: espNvsSummarySchema,
});
