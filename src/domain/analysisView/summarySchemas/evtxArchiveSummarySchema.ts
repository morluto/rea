import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { evtxArchiveSummarySchema } from "../evtxArchiveView.js";

export const evtxArchiveSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_evtx_archive"),
  summary: evtxArchiveSummarySchema,
});
