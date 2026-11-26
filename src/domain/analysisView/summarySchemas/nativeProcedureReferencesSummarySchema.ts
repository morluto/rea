import { z } from "zod";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import { procedureReferenceSummarySchema } from "../nativeProcedureReferencesView.js";
import { nativeViewSourceContext } from "../nativeViewContext.js";

export const nativeProcedureReferencesSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  ...nativeViewSourceContext,
  parent_operation: z.literal("procedure_references"),
  artifact: artifactSchema.nullable(),
  summary: procedureReferenceSummarySchema,
});
