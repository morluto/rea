import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { captureSummarySchema } from "../webNetworkCaptureView.js";

/** Exact historical capture summary, with no body or member-inventory payload. */
export const webNetworkCaptureSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_web_network_capture"),
  summary: captureSummarySchema,
});
