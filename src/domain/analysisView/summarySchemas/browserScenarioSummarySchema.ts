import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { browserScenarioSummarySchema } from "../browserScenarioViewSchemas.js";

/** Compact outcomes and the focus screen from a retained browser scenario. */
export const browserScenarioSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: z.null(),
  parent_operation: z.literal("capture_browser_scenario"),
  summary: browserScenarioSummarySchema,
});
