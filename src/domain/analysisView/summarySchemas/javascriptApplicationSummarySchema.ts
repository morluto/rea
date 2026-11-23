import { z } from "zod";
import { digestSchema } from "../../digests.js";
import { javaScriptSourceSelectionSchema } from "../../javascript/javascriptSourceSelection.js";
import { jsonObjectSchema } from "../../jsonValue.js";
import { summaryViewResultBase } from "../analysisViewBase.js";

const javascriptSummarySchema = z.strictObject({
  input_path: z.string().min(1),
  format: z.enum(["asar", "directory"]),
  root_artifact_sha256: digestSchema,
  source_selection: javaScriptSourceSelectionSchema.exactOptional(),
  statistics: jsonObjectSchema,
  electron: jsonObjectSchema,
  coverage: jsonObjectSchema,
  limitation_count: z.int().nonnegative(),
});

/** Summary `analyze_javascript_application` detail returns; no other view kind. */
export const javascriptApplicationSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  summary: javascriptSummarySchema,
  parent_operation: z.literal("analyze_javascript_application"),
});
