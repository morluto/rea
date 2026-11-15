import { z } from "zod";
import { evidenceInputSchema } from "../domain/evidenceReference.js";
import { compareBrowserScenariosInputSchema } from "../domain/browserScenarioDiffValues.js";
import { compareWebScreenshotsInputSchema } from "../domain/webScreenshot.js";
import { compareWebCapturesInputSchema } from "../domain/webCaptureDiffSchemas.js";

/** Exact authenticated observations, rather than detached normalized payloads. */
export const webCaptureEvidenceInputSchema = z.strictObject({
  left: evidenceInputSchema,
  right: evidenceInputSchema,
  normalization: compareBrowserScenariosInputSchema.shape.normalization,
  origin_mapping: compareBrowserScenariosInputSchema.shape.origin_mapping,
});

export const webScreenshotEvidenceInputSchema = z.strictObject({
  left: evidenceInputSchema,
  right: evidenceInputSchema,
  origin_mapping: compareBrowserScenariosInputSchema.shape.origin_mapping,
  step_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact shared step_id when both sources are browser scenario Evidence.",
    ),
  channel_threshold: z.number().int().min(0).max(255).default(0),
});

/** Legacy payload inputs remain available without qualifying as reconstruction proof. */
export const webCaptureComparisonRequestSchema = z.union(
  [
    compareWebCapturesInputSchema,
    compareBrowserScenariosInputSchema,
    webCaptureEvidenceInputSchema,
  ],
  {
    error: (issue) =>
      issue.code === "invalid_union"
        ? z.prettifyError(new z.ZodError(issue.errors.flat()))
        : undefined,
  },
);
export const webScreenshotComparisonRequestSchema = z.union([
  compareWebScreenshotsInputSchema,
  webScreenshotEvidenceInputSchema,
]);
export type WebCaptureComparisonRequest = z.output<
  typeof webCaptureComparisonRequestSchema
>;
export type WebScreenshotComparisonRequest = z.output<
  typeof webScreenshotComparisonRequestSchema
>;
