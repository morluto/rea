import { z } from "zod";
import { nativeFunctionMatchingContextSchema } from "../../native/functionMatching.js";
import { summaryViewResultBase } from "../analysisViewBase.js";

/** Compact native matching discovery retains the complete matching report. */
export const nativeFunctionMatchingSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: z.null(),
  parent_operation: z.literal("match_native_functions"),
  summary: nativeFunctionMatchingContextSchema,
});
