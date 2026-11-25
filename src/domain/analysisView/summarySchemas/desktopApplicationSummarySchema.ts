import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { desktopSummarySchema } from "../desktopApplicationView.js";

export const desktopApplicationSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_desktop_application"),
  summary: desktopSummarySchema,
});
