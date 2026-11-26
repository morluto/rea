import { z } from "zod";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import { batchDecompileSummarySchema } from "../batchDecompileView.js";

/** Counts and identities of a retained batch without any pseudocode body. */
export const batchDecompileSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: artifactSchema.nullable(),
  parent_operation: z.literal("batch_decompile"),
  summary: batchDecompileSummarySchema,
});
