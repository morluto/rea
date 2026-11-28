import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { labviewArtifactSummarySchema } from "../labviewArtifactView.js";

export const labviewArtifactSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_labview_artifact"),
  summary: labviewArtifactSummarySchema,
});
