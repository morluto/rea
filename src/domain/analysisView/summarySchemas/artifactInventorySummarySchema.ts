import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { artifactInventorySummarySchema } from "../artifactInventoryView.js";

/** Exact summary carrier for artifact inspection's optional delivery contract. */
export const artifactInventorySummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.enum(["inspect_artifact", "inventory_artifact"]),
  summary: artifactInventorySummarySchema,
});
