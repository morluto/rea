import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { warcArchiveSummarySchema } from "../warcArchiveView.js";

export const warcArchiveSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_warc_archive"),
  summary: warcArchiveSummarySchema,
});
