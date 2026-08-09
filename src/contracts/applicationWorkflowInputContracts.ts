import { z } from "zod";

import { evidenceSchema } from "../domain/evidence.js";
import { compareApplicationVersionsInputSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { compareJavaScriptExportShapesInputSchema } from "../domain/javascriptExportShapeComparisonSchemas.js";
import { traceApplicationFeatureInputSchema } from "../domain/javascriptFeatureTraceSchemas.js";
import { javaScriptSemanticQueryInputSchema } from "../domain/javascriptSemanticQuerySchemas.js";
import { compareSourceToBundleInputSchema } from "../domain/sourceToBundleComparisonSchemas.js";

const evidenceIdSchema = z
  .string()
  .regex(/^ev_[a-f0-9]{64}$/u)
  .describe("Evidence ID returned earlier in this session");

const traceApplicationFeatureFacts = {
  native_observations:
    traceApplicationFeatureInputSchema.shape.native_observations,
  native_observation_evidence_ids: z
    .array(evidenceIdSchema)
    .max(64)
    .default([]),
  seed: traceApplicationFeatureInputSchema.shape.seed,
  direction: traceApplicationFeatureInputSchema.shape.direction,
  limits: traceApplicationFeatureInputSchema.shape.limits,
} as const;

/** MCP/CLI trace request accepting full Evidence or a ledger reference. */
export const traceApplicationFeatureRequestSchema = z.union([
  z.strictObject({
    ...traceApplicationFeatureFacts,
    application: evidenceSchema,
  }),
  z.strictObject({
    ...traceApplicationFeatureFacts,
    application_evidence_id: evidenceIdSchema,
  }),
]);

/** MCP/CLI semantic trace request accepting full Evidence or a ledger reference. */
export const traceJavaScriptSemanticsRequestSchema = z.union([
  z.strictObject({
    application: evidenceSchema,
    query: javaScriptSemanticQueryInputSchema,
  }),
  z.strictObject({
    application_evidence_id: evidenceIdSchema,
    query: javaScriptSemanticQueryInputSchema,
  }),
]);

const compareApplicationVersionsFacts = {
  left_native_observations:
    compareApplicationVersionsInputSchema.shape.left_native_observations,
  left_native_observation_evidence_ids: z
    .array(evidenceIdSchema)
    .max(64)
    .default([]),
  right_native_observations:
    compareApplicationVersionsInputSchema.shape.right_native_observations,
  right_native_observation_evidence_ids: z
    .array(evidenceIdSchema)
    .max(64)
    .default([]),
  limits: compareApplicationVersionsInputSchema.shape.limits,
  unknown_registry_approved:
    compareApplicationVersionsInputSchema.shape.unknown_registry_approved,
} as const;

/** MCP/CLI comparison request accepting full Evidence or ledger references. */
export const compareApplicationVersionsRequestSchema = z.union([
  z.strictObject({
    ...compareApplicationVersionsFacts,
    left: evidenceSchema,
    right: evidenceSchema,
  }),
  z.strictObject({
    ...compareApplicationVersionsFacts,
    left: evidenceSchema,
    right_evidence_id: evidenceIdSchema,
  }),
  z.strictObject({
    ...compareApplicationVersionsFacts,
    left_evidence_id: evidenceIdSchema,
    right: evidenceSchema,
  }),
  z.strictObject({
    ...compareApplicationVersionsFacts,
    left_evidence_id: evidenceIdSchema,
    right_evidence_id: evidenceIdSchema,
  }),
]);

const compareSourceToBundleFacts = {
  reference: compareSourceToBundleInputSchema.shape.reference,
  limits: compareSourceToBundleInputSchema.shape.limits,
  unknown_registry_approved:
    compareSourceToBundleInputSchema.shape.unknown_registry_approved,
} as const;

/** Historical-source comparison accepting full application Evidence or a ledger reference. */
export const compareSourceToBundleRequestSchema = z.union([
  z.strictObject({
    ...compareSourceToBundleFacts,
    application: evidenceSchema,
  }),
  z.strictObject({
    ...compareSourceToBundleFacts,
    application_evidence_id: evidenceIdSchema,
  }),
]);

const compareJavaScriptExportShapesFacts = {
  left_module_path:
    compareJavaScriptExportShapesInputSchema.shape.left_module_path,
  left_export_name:
    compareJavaScriptExportShapesInputSchema.shape.left_export_name,
  right_module_path:
    compareJavaScriptExportShapesInputSchema.shape.right_module_path,
  right_export_name:
    compareJavaScriptExportShapesInputSchema.shape.right_export_name,
  limits: compareJavaScriptExportShapesInputSchema.shape.limits,
  unknown_registry_approved:
    compareJavaScriptExportShapesInputSchema.shape.unknown_registry_approved,
} as const;

/** MCP/CLI export-shape request accepting full Evidence or ledger references. */
export const compareJavaScriptExportShapesRequestSchema = z.union([
  z.strictObject({
    ...compareJavaScriptExportShapesFacts,
    left: evidenceSchema,
    right: evidenceSchema,
  }),
  z.strictObject({
    ...compareJavaScriptExportShapesFacts,
    left: evidenceSchema,
    right_evidence_id: evidenceIdSchema,
  }),
  z.strictObject({
    ...compareJavaScriptExportShapesFacts,
    left_evidence_id: evidenceIdSchema,
    right: evidenceSchema,
  }),
  z.strictObject({
    ...compareJavaScriptExportShapesFacts,
    left_evidence_id: evidenceIdSchema,
    right_evidence_id: evidenceIdSchema,
  }),
]);

export type TraceApplicationFeatureRequest = z.output<
  typeof traceApplicationFeatureRequestSchema
>;
export type TraceJavaScriptSemanticsRequest = z.output<
  typeof traceJavaScriptSemanticsRequestSchema
>;
export type CompareApplicationVersionsRequest = z.output<
  typeof compareApplicationVersionsRequestSchema
>;
export type CompareSourceToBundleRequest = z.output<
  typeof compareSourceToBundleRequestSchema
>;
export type CompareJavaScriptExportShapesRequest = z.output<
  typeof compareJavaScriptExportShapesRequestSchema
>;
