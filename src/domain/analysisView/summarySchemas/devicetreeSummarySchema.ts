import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { devicetreeSummarySchema } from "../devicetreeView.js";

export const devicetreeSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_devicetree"),
  summary: devicetreeSummarySchema,
});
