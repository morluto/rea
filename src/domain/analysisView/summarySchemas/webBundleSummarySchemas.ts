import { z } from "zod";
import { recordedBrowserOriginSchema } from "../../browserObservation.js";
import { webBundleAnalysisSchema } from "../../webBundleAnalysis.js";
import {
  artifactSchema,
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  webBundleSummarySchema,
  webBundleViewItemsSchema,
  webBundleViewRequestSchema,
  webBundleViewSourceUnknownsSchema,
} from "../webBundleView.js";

/** Compact web bundle findings retain endpoint observations and inference candidates. */
export const webBundleSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: artifactSchema.nullable(),
  parent_operation: z.literal("analyze_web_bundle"),
  target_url: z.string(),
  target_origin: recordedBrowserOriginSchema.nullable(),
  source_unknowns: webBundleViewSourceUnknownsSchema,
  summary: webBundleSummarySchema,
});

export const webBundlePageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  artifact: artifactSchema.nullable(),
  kind: z.literal("web-bundle"),
  parent_operation: z.literal("analyze_web_bundle"),
  target_url: z.string(),
  target_origin: recordedBrowserOriginSchema.nullable(),
  source_unknowns: webBundleViewSourceUnknownsSchema,
  view: webBundleViewRequestSchema,
  completeness: webBundleAnalysisSchema.shape.completeness,
  items: webBundleViewItemsSchema,
  summary: webBundleSummarySchema.nullable(),
  byte_limited: z.boolean(),
});
