import { z } from "zod";
import { evidenceSchema } from "./evidence.js";
import { digestSchema } from "./../domain/digests.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const comparisonStatusSchema = z.enum(["unchanged", "changed", "unknown"]);
const dimensionNameSchema = z.enum([
  "identity",
  "pseudocode",
  "assembly",
  "comments",
  "calls",
  "references",
  "strings_names",
  "cfg",
]);
const evidenceIdSchema = prefixedDigestSchema("ev");

/** Inputs for explicit function-to-function comparison. */
export const functionComparisonInputSchema = z.strictObject({
  left: evidenceSchema,
  right: evidenceSchema,
});

const textDeltaSchema = z.object({
  added_lines: z.number().int().min(0),
  removed_lines: z.number().int().min(0),
  hunks: z.number().int().min(0),
});

const functionDimensionContextShape = {
  dimension: dimensionNameSchema,
  left_count: z.number().int().min(0).nullable(),
  right_count: z.number().int().min(0).nullable(),
  evidence_links: z.array(evidenceIdSchema).min(2),
  limitations: z.array(z.string()),
};

const functionDimensionSchema = z.union([
  z.object({
    ...functionDimensionContextShape,
    status: z.literal("unchanged"),
    left_digest: digestSchema,
    right_digest: digestSchema,
    text_delta: textDeltaSchema.nullable(),
    conclusion_kind: z.literal("derived_relationship"),
  }),
  z.object({
    ...functionDimensionContextShape,
    status: z.literal("changed"),
    left_digest: digestSchema,
    right_digest: digestSchema,
    text_delta: textDeltaSchema.nullable(),
    conclusion_kind: z.enum(["derived_relationship", "contradiction"]),
  }),
  z.object({
    ...functionDimensionContextShape,
    status: z.literal("unknown"),
    left_digest: z.null(),
    right_digest: z.null(),
    text_delta: z.null(),
    conclusion_kind: z.literal("unresolved_branch"),
  }),
]);

const functionMatchSchema = z.union([
  z.object({
    status: z.literal("matched"),
    method: z.literal("symbol"),
    left_name: z.string(),
    right_name: z.string(),
  }),
  z.object({
    status: z.enum(["mismatched", "ambiguous"]),
    method: z.literal("explicit"),
    left_name: z.string(),
    right_name: z.string(),
  }),
]);

/** Deterministic dimension-classified function comparison Evidence payload. */
export const functionComparisonResultSchema = z.object({
  status: comparisonStatusSchema,
  function_match: functionMatchSchema,
  left_subject_sha256: digestSchema,
  right_subject_sha256: digestSchema,
  summary: z.object({
    unchanged: z.number().int().min(0),
    changed: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  dimensions: z.array(functionDimensionSchema).length(8),
  changes: z.array(functionDimensionSchema),
  limitations: z.array(z.string()),
});

export type FunctionComparisonResult = z.infer<
  typeof functionComparisonResultSchema
>;
export type FunctionDimension = z.infer<typeof functionDimensionSchema>;
export type DimensionName = z.infer<typeof dimensionNameSchema>;
