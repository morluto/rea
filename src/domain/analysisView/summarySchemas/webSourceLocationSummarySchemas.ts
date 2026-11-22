import { z } from "zod";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import { nullableCollectionViewCoverageSchema } from "../analysisViewCoverage.js";
import { analysisTextPageItemSchema } from "../analysisViewText.js";
import {
  webSourceLocationContextSchema,
  webSourceLocationMatchViewSchema,
  webSourceLocationSummarySchema,
  webSourceLocationViewRequestSchema,
} from "../webSourceLocationView.js";

export const webSourceLocationSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("trace_web_source_location"),
  summary: webSourceLocationSummarySchema,
});

export const webSourceLocationMatchesViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("source-location"),
  parent_operation: z.literal("trace_web_source_location"),
  view: webSourceLocationViewRequestSchema.options[0],
  source_location: webSourceLocationContextSchema,
  items: z.array(webSourceLocationMatchViewSchema),
});

export const webSourceLocationTextViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("source-location-text"),
  coverage: nullableCollectionViewCoverageSchema,
  parent_operation: z.literal("trace_web_source_location"),
  view: webSourceLocationViewRequestSchema.options[1],
  source_location: webSourceLocationContextSchema,
  match: webSourceLocationMatchViewSchema,
  item: analysisTextPageItemSchema.nullable(),
});
