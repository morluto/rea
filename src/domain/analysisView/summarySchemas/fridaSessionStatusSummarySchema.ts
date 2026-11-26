import { z } from "zod";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import {
  fridaSessionStatusSummarySchema,
  fridaSessionStatusViewContext,
} from "../fridaSessionStatusView.js";

export const fridaSessionStatusSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  ...fridaSessionStatusViewContext,
  parent_operation: z.literal("frida_session_status"),
  artifact: artifactSchema.nullable(),
  summary: fridaSessionStatusSummarySchema,
});
