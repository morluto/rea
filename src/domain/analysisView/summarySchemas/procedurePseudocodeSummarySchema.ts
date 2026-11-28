import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { procedurePseudocodeSummarySchema } from "../procedurePseudocodeSchemas.js";

/** Original selector and text availability without the complete decompiled text. */
export const procedurePseudocodeSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("procedure_pseudo_code"),
  summary: procedurePseudocodeSummarySchema,
});
