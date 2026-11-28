import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { debPackageSummarySchema } from "../debPackageView.js";

export const debPackageSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_deb_package"),
  summary: debPackageSummarySchema,
});
