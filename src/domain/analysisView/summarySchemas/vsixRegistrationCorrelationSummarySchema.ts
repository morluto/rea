import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { vsixRegistrationCorrelationSummarySchema } from "../vsixRegistrationCorrelationView.js";

export const vsixRegistrationCorrelationSummaryViewResultSchema =
  z.strictObject({
    ...summaryViewResultBase,
    parent_operation: z.literal("correlate_vsix_registrations"),
    summary: vsixRegistrationCorrelationSummarySchema,
  });
