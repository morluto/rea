import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { il2cppMetadataSummarySchema } from "../il2cppMetadataView.js";

/** Metadata identity and row counts for selected IL2CPP delivery. */
export const il2cppMetadataSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_il2cpp_metadata"),
  summary: il2cppMetadataSummarySchema,
});
