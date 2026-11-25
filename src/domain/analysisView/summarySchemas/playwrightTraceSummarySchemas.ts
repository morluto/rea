import { z } from "zod";
import { playwrightTraceViewRequestSchema } from "../../playwrightTrace/playwrightTraceQuery.js";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  playwrightTraceViewContextSchema,
  playwrightTraceViewItemsSchema,
} from "../playwrightTraceView.js";

export const playwrightTraceSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_playwright_trace"),
  summary: playwrightTraceViewContextSchema,
});

export const playwrightTracePageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  ...playwrightTraceViewContextSchema.shape,
  kind: z.literal("playwright-trace"),
  parent_operation: z.literal("inspect_playwright_trace"),
  view: playwrightTraceViewRequestSchema,
  items: playwrightTraceViewItemsSchema,
});
