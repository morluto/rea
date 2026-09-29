import { z } from "zod";

import { evidenceSchema } from "../domain/evidence.js";
import { compareApplicationVersionsInputSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { compareJavaScriptExportShapesInputSchema } from "../domain/javascriptExportShapeComparisonSchemas.js";
import { traceApplicationFeatureInputSchema } from "../domain/javascriptFeatureTraceSchemas.js";
import { javaScriptSemanticQueryInputSchema } from "../domain/javascriptSemanticQuerySchemas.js";
import { compareSourceToBundleInputSchema } from "../domain/sourceToBundleComparisonSchemas.js";

const traceApplicationFeatureFacts = {
  native_observations:
    traceApplicationFeatureInputSchema.shape.native_observations,
  seed: traceApplicationFeatureInputSchema.shape.seed,
  direction: traceApplicationFeatureInputSchema.shape.direction,
} as const;

/** MCP/CLI trace request carrying all Evidence inline. */
export const traceApplicationFeatureRequestSchema = z.strictObject({
  ...traceApplicationFeatureFacts,
  application: evidenceSchema,
});

/** MCP/CLI semantic trace request carrying Evidence inline. */
export const traceJavaScriptSemanticsRequestSchema = z.strictObject({
  application: evidenceSchema,
  query: javaScriptSemanticQueryInputSchema,
});

const compareApplicationVersionsFacts = {
  left_native_observations:
    compareApplicationVersionsInputSchema.shape.left_native_observations,
  right_native_observations:
    compareApplicationVersionsInputSchema.shape.right_native_observations,
} as const;

/** MCP/CLI comparison request carrying all Evidence inline. */
export const compareApplicationVersionsRequestSchema = z.strictObject({
  ...compareApplicationVersionsFacts,
  left: evidenceSchema,
  right: evidenceSchema,
});

const compareSourceToBundleFacts = {
  reference: compareSourceToBundleInputSchema.shape.reference,
} as const;

/** Historical-source comparison carrying application Evidence inline. */
export const compareSourceToBundleRequestSchema = z.strictObject({
  ...compareSourceToBundleFacts,
  application: evidenceSchema,
});

const compareJavaScriptExportShapesFacts = {
  left_module_path:
    compareJavaScriptExportShapesInputSchema.shape.left_module_path,
  left_export_name:
    compareJavaScriptExportShapesInputSchema.shape.left_export_name,
  right_module_path:
    compareJavaScriptExportShapesInputSchema.shape.right_module_path,
  right_export_name:
    compareJavaScriptExportShapesInputSchema.shape.right_export_name,
} as const;

/** MCP/CLI export-shape request carrying application Evidence inline. */
export const compareJavaScriptExportShapesRequestSchema = z.strictObject({
  ...compareJavaScriptExportShapesFacts,
  left: evidenceSchema,
  right: evidenceSchema,
});
