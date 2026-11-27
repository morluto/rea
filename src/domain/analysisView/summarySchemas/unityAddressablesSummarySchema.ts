import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { unityAddressablesSummarySchema } from "../unityAddressablesView.js";

/** Catalog identity and row counts for selected Unity Addressables delivery. */
export const unityAddressablesSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_unity_addressables"),
  summary: unityAddressablesSummarySchema,
});
