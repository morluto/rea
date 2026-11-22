import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { pcapSummarySchema } from "../pcapCaptureView.js";

export const pcapCaptureSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_pcap_capture"),
  summary: pcapSummarySchema,
});
