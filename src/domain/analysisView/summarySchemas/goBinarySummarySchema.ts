import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import {
  goBinarySummarySchema,
  goBinaryViewContextSchema,
} from "../goBinaryView.js";

/** Opt-in Go delivery retains original bytes and exposes build identity/counts. */
export const goBinarySummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  ...goBinaryViewContextSchema.shape,
  parent_operation: z.literal("inspect_go_binary"),
  summary: goBinarySummarySchema,
});
