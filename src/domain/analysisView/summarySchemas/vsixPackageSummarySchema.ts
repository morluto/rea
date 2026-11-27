import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { vsixPackageSummarySchema } from "../vsixPackageView.js";

export const vsixPackageSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_vsix_package"),
  summary: vsixPackageSummarySchema,
});
