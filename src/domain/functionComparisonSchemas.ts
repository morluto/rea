import { z } from "zod";

import { evidenceSchema } from "./evidence.js";

const evidenceInput = z.union([
  evidenceSchema,
  z.array(evidenceSchema).min(1).max(100),
]);
const comparisonStatusSchema = z.enum([
  "unchanged",
  "added",
  "removed",
  "changed",
  "truncated",
  "unknown",
]);
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
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Strict bounded input for explicit function-to-function comparison. */
export const functionComparisonInputSchema = z.object({
  left: evidenceInput,
  right: evidenceInput,
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(100),
  unknown_registry_approved: z.literal(true).optional(),
});

const textDeltaSchema = z.object({
  added_lines: z.number().int().min(0),
  removed_lines: z.number().int().min(0),
  hunks: z.number().int().min(0),
});

const functionDimensionSchema = z.object({
  dimension: dimensionNameSchema,
  status: comparisonStatusSchema,
  left_digest: digestSchema.nullable(),
  right_digest: digestSchema.nullable(),
  left_count: z.number().int().min(0).nullable(),
  right_count: z.number().int().min(0).nullable(),
  text_delta: textDeltaSchema.nullable(),
  conclusion_kind: z.enum([
    "derived_relationship",
    "contradiction",
    "unresolved_branch",
  ]),
  evidence_links: z.array(evidenceIdSchema).min(2).max(200),
  limitations: z.array(z.string()),
});

/** Deterministic dimension-classified function comparison Evidence payload. */
export const functionComparisonResultSchema = z.object({
  status: comparisonStatusSchema,
  function_match: z.object({
    status: z.enum(["matched", "mismatched", "ambiguous", "unknown"]),
    method: z.enum(["explicit", "symbol"]),
    left_name: z.string(),
    right_name: z.string(),
  }),
  left_subject_sha256: digestSchema,
  right_subject_sha256: digestSchema,
  summary: z.object({
    unchanged: z.number().int().min(0),
    changed: z.number().int().min(0),
    truncated: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  dimensions: z.array(functionDimensionSchema).length(8),
  changes: z.object({
    items: z.array(functionDimensionSchema).max(100),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
  }),
  limitations: z.array(z.string()),
});

export type FunctionComparisonResult = z.infer<
  typeof functionComparisonResultSchema
>;
export type FunctionDimension = z.infer<typeof functionDimensionSchema>;
export type DimensionName = z.infer<typeof dimensionNameSchema>;
