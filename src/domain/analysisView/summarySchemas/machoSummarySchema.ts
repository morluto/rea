import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { machoSummarySchema } from "../machoView.js";

/** Exact slice identity and collection counts for Mach-O's selected delivery. */
export const machoSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_macho"),
  summary: machoSummarySchema,
});
