import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { unrealPakSummarySchema } from "../unrealPakView.js";

/** Footer, index facts and entry counts for selected Unreal pak delivery. */
export const unrealPakSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_unreal_pak"),
  summary: unrealPakSummarySchema,
});
