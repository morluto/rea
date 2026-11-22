import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { nugetNupkgSummarySchema } from "../nugetNupkgView.js";

export const nugetNupkgSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_nuget_nupkg"),
  summary: nugetNupkgSummarySchema,
});
