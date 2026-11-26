import { z } from "zod";
import { webExecutionObservationSchema } from "../../webExecution.js";
import {
  artifactSchema,
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  webExecutionSummarySchema,
  webExecutionViewItemsSchema,
  webExecutionViewRequestSchema,
} from "../webExecutionView.js";

/** Counts and context of one retained observe_web_execution observation. */
export const webExecutionSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: artifactSchema.nullable(),
  parent_operation: z.literal("observe_web_execution"),
  target_url: z.string(),
  summary: webExecutionSummarySchema,
});

/** One page of a retained observation's functions, requests, sources or source text. */
export const webExecutionPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  artifact: artifactSchema.nullable(),
  kind: z.literal("web-execution"),
  parent_operation: z.literal("observe_web_execution"),
  target_url: z.string(),
  view: webExecutionViewRequestSchema,
  coverage_context: webExecutionObservationSchema.shape.coverage.omit({
    scripts: true,
  }),
  script_inventory: z.strictObject({
    main_document_scripts: z.int().nonnegative(),
    not_reported_scripts: z.int().nonnegative(),
    coverage_absence: z.literal("unknown"),
  }),
  items: webExecutionViewItemsSchema,
});
