import { z } from "zod";

import { evidenceInputSchema } from "./evidenceInputContracts.js";
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

/** Application trace request accepting inline or same-session application Evidence. */
export const traceApplicationFeatureRequestSchema = z.strictObject({
  ...traceApplicationFeatureFacts,
  application: evidenceInputSchema,
});

/** Semantic trace request accepting inline or same-session application Evidence. */
export const traceJavaScriptSemanticsRequestSchema = z.strictObject({
  application: evidenceInputSchema,
  query: javaScriptSemanticQueryInputSchema,
});

const compareApplicationVersionsFacts = {
  left_native_observations:
    compareApplicationVersionsInputSchema.shape.left_native_observations,
  right_native_observations:
    compareApplicationVersionsInputSchema.shape.right_native_observations,
} as const;

/** Application comparison request accepting inline or same-session application Evidence. */
export const compareApplicationVersionsRequestSchema = z.strictObject({
  ...compareApplicationVersionsFacts,
  left: evidenceInputSchema,
  right: evidenceInputSchema,
});

const compareSourceToBundleFacts = {
  reference: compareSourceToBundleInputSchema.shape.reference,
} as const;

/** Historical-source comparison accepting inline or same-session application Evidence. */
export const compareSourceToBundleRequestSchema = z.strictObject({
  ...compareSourceToBundleFacts,
  application: evidenceInputSchema,
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

/** Export-shape request accepting inline or same-session application Evidence. */
export const compareJavaScriptExportShapesRequestSchema = z.strictObject({
  ...compareJavaScriptExportShapesFacts,
  left: evidenceInputSchema,
  right: evidenceInputSchema,
});
