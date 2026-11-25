import { z } from "zod";
import { nativeInventoryOperationSchema } from "../../native/nativeInventory.js";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import { nativeInventorySummarySchema } from "../nativeInventoryView.js";
import { nativeViewSourceContext } from "../nativeViewContext.js";

/** Exact inventory summary with the original observation's provider and query. */
export const nativeInventorySummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  ...nativeViewSourceContext,
  parent_operation: nativeInventoryOperationSchema,
  artifact: artifactSchema.nullable(),
  summary: nativeInventorySummarySchema,
});
