import { z } from "zod";
import { webExecutionObservationSchema } from "../../webExecution.js";
import {
  artifactSchema,
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  webExecutionCollections,
  webExecutionSummarySchema,
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

const page = z.strictObject({
  ...viewResultBaseFields,
  artifact: artifactSchema.nullable(),
  kind: z.literal("web-execution"),
  parent_operation: z.literal("observe_web_execution"),
  target_url: z.string(),
  // Keep the serialized field order when each collection narrows its view.
  view: webExecutionViewRequestSchema,
  coverage_context: webExecutionObservationSchema.shape.coverage.omit({
    scripts: true,
  }),
  script_inventory: z.strictObject({
    main_document_scripts: z.int().nonnegative(),
    not_reported_scripts: z.int().nonnegative(),
    coverage_absence: z.literal("unknown"),
  }),
});

/** Keep outer kind dispatch while validating each collection with its own rows. */
export const webExecutionPageViewResultSchema = z
  .object({ kind: page.shape.kind })
  .passthrough()
  .pipe(
    z.union([
      page.extend(webExecutionCollections.functions),
      page.extend(webExecutionCollections.requests),
      page.extend(webExecutionCollections.sources),
      page.extend(webExecutionCollections["source-text"]),
    ]),
  );
