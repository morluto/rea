import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { nativeExportsSummarySchema } from "../nativeExportsView.js";

export const nativeExportsSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_native_exports"),
  summary: nativeExportsSummarySchema,
});
