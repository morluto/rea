import { z } from "zod";

import { evidenceSchema } from "../domain/evidence.js";
import { compareApplicationVersionsInputSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { compareJavaScriptExportShapesInputSchema } from "../domain/javascriptExportShapeComparisonSchemas.js";
import { traceApplicationFeatureInputSchema } from "../domain/javascriptFeatureTraceSchemas.js";

const evidenceIdSchema = z
  .string()
  .regex(/^ev_[a-f0-9]{64}$/u)
  .describe("Evidence ID returned earlier in this session");

const requireExactlyOne = (
  context: z.RefinementCtx,
  fields: readonly [string, unknown, string, unknown],
): void => {
  const [leftName, left, rightName, right] = fields;
  if ((left === undefined) !== (right === undefined)) return;
  context.addIssue({
    code: "custom",
    path: [left === undefined ? leftName : rightName],
    message: `Supply exactly one of ${leftName} or ${rightName}`,
  });
};

/** MCP/CLI trace request accepting full Evidence or a ledger reference. */
export const traceApplicationFeatureRequestSchema = z
  .strictObject({
    application: evidenceSchema.optional(),
    application_evidence_id: evidenceIdSchema.optional(),
    native_observations:
      traceApplicationFeatureInputSchema.shape.native_observations,
    native_observation_evidence_ids: z
      .array(evidenceIdSchema)
      .max(64)
      .default([]),
    seed: traceApplicationFeatureInputSchema.shape.seed,
    direction: traceApplicationFeatureInputSchema.shape.direction,
    limits: traceApplicationFeatureInputSchema.shape.limits,
  })
  .superRefine((input, context) => {
    requireExactlyOne(context, [
      "application",
      input.application,
      "application_evidence_id",
      input.application_evidence_id,
    ]);
  });

/** MCP/CLI comparison request accepting full Evidence or ledger references. */
export const compareApplicationVersionsRequestSchema = z
  .strictObject({
    left: evidenceSchema.optional(),
    left_evidence_id: evidenceIdSchema.optional(),
    right: evidenceSchema.optional(),
    right_evidence_id: evidenceIdSchema.optional(),
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
  })
  .superRefine((input, context) => {
    requireExactlyOne(context, [
      "left",
      input.left,
      "left_evidence_id",
      input.left_evidence_id,
    ]);
    requireExactlyOne(context, [
      "right",
      input.right,
      "right_evidence_id",
      input.right_evidence_id,
    ]);
  });

/** MCP/CLI export-shape request accepting full Evidence or ledger references. */
export const compareJavaScriptExportShapesRequestSchema = z
  .strictObject({
    left: evidenceSchema.optional(),
    left_evidence_id: evidenceIdSchema.optional(),
    right: evidenceSchema.optional(),
    right_evidence_id: evidenceIdSchema.optional(),
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
  })
  .superRefine((input, context) => {
    requireExactlyOne(context, [
      "left",
      input.left,
      "left_evidence_id",
      input.left_evidence_id,
    ]);
    requireExactlyOne(context, [
      "right",
      input.right,
      "right_evidence_id",
      input.right_evidence_id,
    ]);
  });

export type TraceApplicationFeatureRequest = z.output<
  typeof traceApplicationFeatureRequestSchema
>;
export type CompareApplicationVersionsRequest = z.output<
  typeof compareApplicationVersionsRequestSchema
>;
export type CompareJavaScriptExportShapesRequest = z.output<
  typeof compareJavaScriptExportShapesRequestSchema
>;
