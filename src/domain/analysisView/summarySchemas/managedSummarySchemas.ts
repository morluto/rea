import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { managedSummarySchema } from "../managedArtifactView.js";
import { managedMemberSummarySchema } from "../managedMemberViewSchemas.js";

/** Exact metadata overview for the managed artifact's selected delivery. */
export const managedArtifactSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_managed_artifact"),
  summary: managedSummarySchema,
});

/** Exact member selection, coverage and counts for the selected delivery. */
export const managedMemberSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_managed_members"),
  summary: managedMemberSummarySchema,
});
