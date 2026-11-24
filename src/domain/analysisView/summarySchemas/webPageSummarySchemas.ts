import { z } from "zod";
import {
  artifactSchema,
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import { webPageInspectionSchema } from "../../browserObservationSchemas.js";
import {
  webPageSectionSchema,
  webPageSummarySchema,
  webPageViewItemsSchema,
  webPageViewRequestSchema,
} from "../webPageView.js";

/** Counts and small context of one retained inspect_web_page capture. */
export const webPageSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: artifactSchema.nullable(),
  parent_operation: z.literal("inspect_web_page"),
  target_url: z.string(),
  summary: webPageSummarySchema,
});

/** One page of a retained capture's DOM, accessibility, console, network, script or resource rows. */
export const webPagePageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  artifact: artifactSchema.nullable(),
  kind: z.literal("web-page"),
  parent_operation: z.literal("inspect_web_page"),
  target_url: z.string(),
  view: webPageViewRequestSchema,
  completeness: webPageInspectionSchema.shape.completeness,
  section: webPageSectionSchema,
  items: webPageViewItemsSchema,
});
