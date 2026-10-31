import { z } from "zod";
import { overallStatus, summarize } from "./functionComparisonResults.js";
import { canonicalJson } from "./comparisonSemantics.js";
import { evidenceInputSchema } from "./evidenceReference.js";
import { digestSchema, prefixedDigestSchema } from "./../domain/digests.js";

const comparisonStatusSchema = z.enum(["unchanged", "changed", "unknown"]);
export const functionComparisonDimensionNameSchema = z.enum([
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

/** Opt-in address-normalized text views; the eight exact dimensions are unchanged. */
export const NORMALIZED_VIEW_DIMENSIONS = [
  "pseudocode_normalized",
  "assembly_normalized",
] as const;
const normalizedViewDimensionSchema = z.enum(NORMALIZED_VIEW_DIMENSIONS);

/** Recognize one opt-in normalized view name without widening the exact set. */
export const isNormalizedViewDimension = (
  dimension: string,
): dimension is NormalizedViewDimension =>
  NORMALIZED_VIEW_DIMENSIONS.some((name) => name === dimension);

/** Inputs for explicit function-to-function comparison. */
export const functionComparisonInputSchema = z.strictObject({
  left: evidenceInputSchema,
  right: evidenceInputSchema,
  include_normalized_views: z
    .boolean()
    .default(false)
    .describe(
      "Opt in to separate address-normalized pseudocode and assembly views beside the eight exact dimensions. Exact dimensions, changes, summary counts, and overall status keep their current meaning. Normalized views rewrite recognized address-derived identifiers and dossier-corroborated addresses as entry-relative offsets inside the observed function body and as side-local ordinal placeholders outside it, so normalized equality does not establish that both sides reference the same procedure, data, or label.",
    ),
});

const textDeltaSchema = z.object({
  added_lines: z.int().min(0),
  removed_lines: z.int().min(0),
  hunks: z.int().min(0),
});

const functionDimensionContextShape = {
  dimension: functionComparisonDimensionNameSchema,
  left_count: z.int().min(0).nullable(),
  right_count: z.int().min(0).nullable(),
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

/** Counts of what one side's normalization masked and what it deliberately left visible. */
const maskingCountsSchema = z.strictObject({
  address_derived_identifiers: z.int().min(0),
  unmasked_address_derived_identifiers: z.int().min(0),
  corroborated_addresses: z.int().min(0),
  visible_addresses: z.int().min(0),
});
const maskingRuleSchema = z.strictObject({
  rule: z.string().min(1),
  description: z.string().min(1),
});
const maskingSchema = z.strictObject({
  policy: z.literal("rea-address-normalized-text-v1"),
  provider_id: z.string().min(1),
  rules: z.array(maskingRuleSchema).min(1),
  left: maskingCountsSchema,
  right: maskingCountsSchema,
});
const normalizedViewContextShape = {
  dimension: normalizedViewDimensionSchema,
  left_digest: digestSchema.nullable(),
  right_digest: digestSchema.nullable(),
  left_count: z.int().min(0).nullable(),
  right_count: z.int().min(0).nullable(),
  text_delta: textDeltaSchema.nullable(),
  evidence_links: z.array(evidenceIdSchema).min(2),
  masking: maskingSchema.nullable(),
  limitations: z.array(z.string()),
};

/** Facts both completed projections carry, whatever the view concludes. */
const projectedFactsShape = {
  left_digest: digestSchema,
  right_digest: digestSchema,
  left_count: z.int().min(0),
  right_count: z.int().min(0),
  masking: maskingSchema,
};

/**
 * One opt-in normalized text view. An unknown view keeps its digests and masking
 * when both projections completed; otherwise absent masking reports why.
 */
const normalizedTextViewSchema = z.union([
  z.object({
    ...normalizedViewContextShape,
    ...projectedFactsShape,
    status: z.literal("unchanged"),
    text_delta: textDeltaSchema,
    conclusion_kind: z.literal("derived_relationship"),
  }),
  z.object({
    ...normalizedViewContextShape,
    ...projectedFactsShape,
    status: z.literal("changed"),
    text_delta: textDeltaSchema,
    conclusion_kind: z.literal("derived_relationship"),
  }),
  z.object({
    ...normalizedViewContextShape,
    ...projectedFactsShape,
    status: z.literal("unknown"),
    text_delta: z.null(),
    conclusion_kind: z.literal("unresolved_branch"),
  }),
  z.object({
    ...normalizedViewContextShape,
    status: z.literal("unknown"),
    left_digest: z.null(),
    right_digest: z.null(),
    left_count: z.null(),
    right_count: z.null(),
    text_delta: z.null(),
    masking: z.null(),
    conclusion_kind: z.literal("unresolved_branch"),
  }),
]);

/** Deterministic opt-in normalized text views beside the exact dimensions. */
export const functionNormalizedViewsSchema = z
  .strictObject({
    policy: z.literal("rea-address-normalized-text-v1"),
    views: z.array(normalizedTextViewSchema).length(2),
    limitations: z.array(z.string()),
  })
  .superRefine((normalizedViews, context) => {
    for (const dimension of NORMALIZED_VIEW_DIMENSIONS) {
      if (
        normalizedViews.views.filter((view) => view.dimension === dimension)
          .length !== 1
      )
        context.addIssue({
          code: "custom",
          message: `Expected exactly one ${dimension} view`,
          path: ["views"],
        });
    }
    for (const [index, view] of normalizedViews.views.entries()) {
      if (view.status === "unknown") continue;
      const equal =
        view.left_digest === view.right_digest &&
        view.left_count === view.right_count &&
        view.text_delta.hunks === 0 &&
        view.text_delta.added_lines === 0 &&
        view.text_delta.removed_lines === 0;
      const different =
        view.left_digest !== view.right_digest && view.text_delta.hunks > 0;
      if (view.status === "unchanged" ? !equal : !different)
        context.addIssue({
          code: "custom",
          message: `A ${view.status} normalized view contradicts its projected facts`,
          path: ["views", index],
        });
    }
  });

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
export const functionComparisonResultSchema = z
  .object({
    status: comparisonStatusSchema,
    function_match: functionMatchSchema,
    left_subject_sha256: digestSchema,
    right_subject_sha256: digestSchema,
    summary: z.object({
      unchanged: z.int().min(0),
      changed: z.int().min(0),
      unknown: z.int().min(0),
    }),
    dimensions: z
      .array(functionDimensionSchema)
      .length(functionComparisonDimensionNameSchema.options.length),
    changes: z.array(functionDimensionSchema),
    normalized_views: functionNormalizedViewsSchema.optional(),
    limitations: z.array(z.string()),
  })
  .superRefine((result, context) => {
    const dimensions = new Map<DimensionName, FunctionDimension>();
    for (const [index, dimension] of result.dimensions.entries()) {
      if (dimensions.has(dimension.dimension))
        context.addIssue({
          code: "custom",
          path: ["dimensions", index, "dimension"],
          message: "Function comparison dimensions must occur exactly once.",
        });
      dimensions.set(dimension.dimension, dimension);
    }
    const expectedSummary = summarize(result.dimensions);
    for (const status of comparisonStatusSchema.options)
      if (result.summary[status] !== expectedSummary[status])
        context.addIssue({
          code: "custom",
          path: ["summary", status],
          message: "Function comparison summary must count its dimensions.",
        });
    const changes = new Set<DimensionName>();
    for (const [index, change] of result.changes.entries()) {
      const dimension = dimensions.get(change.dimension);
      if (
        changes.has(change.dimension) ||
        dimension === undefined ||
        change.status === "unchanged" ||
        canonicalJson(change) !== canonicalJson(dimension)
      )
        context.addIssue({
          code: "custom",
          path: ["changes", index],
          message:
            "Function comparison changes must cite each changed or unknown dimension exactly as recorded.",
        });
      changes.add(change.dimension);
    }
    if (
      result.dimensions.some(
        ({ dimension, status }) =>
          status !== "unchanged" && !changes.has(dimension),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["changes"],
        message:
          "Function comparison changes must include every changed or unknown dimension.",
      });
    if (
      result.status !==
      overallStatus(result.dimensions, result.function_match.status)
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Function comparison status contradicts its dimensions or function match.",
      });
  });

export type FunctionComparisonResult = z.infer<
  typeof functionComparisonResultSchema
>;
export type FunctionDimension = z.infer<typeof functionDimensionSchema>;
export type DimensionName = z.infer<
  typeof functionComparisonDimensionNameSchema
>;
export type NormalizedViewDimension = z.infer<
  typeof normalizedViewDimensionSchema
>;
export type NormalizedTextView = z.infer<typeof normalizedTextViewSchema>;
export type MaskingCounts = z.infer<typeof maskingCountsSchema>;
export type FunctionNormalizedViews = z.infer<
  typeof functionNormalizedViewsSchema
>;
