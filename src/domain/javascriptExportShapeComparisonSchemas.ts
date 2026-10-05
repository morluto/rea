import { z } from "zod";

import { evidenceSchema } from "./evidence.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const evidenceIdSchema = prefixedDigestSchema("ev");
const graphIdSchema = prefixedDigestSchema("jag");
const nodeIdSchema = prefixedDigestSchema("jag_node");
const textSchema = z.string().min(1);
const selectorTextSchema = textSchema;
const semanticPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

function isJsonPointer(value: string): boolean {
  if (value === "") return true;
  if (!value.startsWith("/")) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "~") continue;
    const escaped = value[index + 1];
    if (escaped !== "0" && escaped !== "1") return false;
    index += 1;
  }
  return true;
}

const jsonPointerSchema = z
  .string()
  .refine(isJsonPointer, "Expected an RFC 6901 JSON Pointer");

const sourcePointSchema = z.strictObject({
  line: z.number().int().min(1),
  column: z.number().int().min(0),
});

const sourceRangeSchema = z
  .strictObject({
    start: sourcePointSchema,
    end: sourcePointSchema,
  })
  .superRefine((range, context) => {
    if (
      range.end.line < range.start.line ||
      (range.end.line === range.start.line &&
        range.end.column < range.start.column)
    )
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "Source range end must not precede its start",
      });
  });

/** Two authenticated application graphs and exact export selectors. */
export const compareJavaScriptExportShapesInputSchema = z
  .strictObject({
    left: evidenceSchema,
    right: evidenceSchema,
    left_module_path: selectorTextSchema,
    left_export_name: selectorTextSchema,
    right_module_path: selectorTextSchema,
    right_export_name: selectorTextSchema,
  })
  .superRefine((input, context) => {
    if (input.left.evidence_id === input.right.evidence_id)
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "JavaScript export shape Evidence must be distinct",
      });
  });

const projectedReturnFieldShape = { path: jsonPointerSchema };
const projectedReturnFieldSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...projectedReturnFieldShape,
    state: z.literal("literal"),
    value: semanticPrimitiveSchema,
    reason: z.null(),
  }),
  z.strictObject({
    ...projectedReturnFieldShape,
    state: z.literal("union"),
    value: z.array(semanticPrimitiveSchema).min(1),
    reason: z.null(),
  }),
  z.strictObject({
    ...projectedReturnFieldShape,
    state: z.literal("unknown"),
    value: z.null(),
    reason: textSchema,
  }),
]);
export type ProjectedReturnField = z.infer<typeof projectedReturnFieldSchema>;

const projectedPropertyCoverageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    path: jsonPointerSchema,
    status: z.literal("complete"),
    omitted: z.literal(0),
  }),
  z.strictObject({
    path: jsonPointerSchema,
    status: z.literal("partial"),
    omitted: z.union([z.number().int().positive(), z.null()]),
  }),
]);
export type ProjectedPropertyCoverage = z.infer<
  typeof projectedPropertyCoverageSchema
>;

const projectedReturnShapeSchema = z
  .strictObject({
    source_range: sourceRangeSchema,
    value_status: z.enum([
      "literal",
      "union",
      "object",
      "array",
      "unknown",
      "ambiguous",
      "cycle",
    ]),
    fields: z.array(projectedReturnFieldSchema),
    property_coverage: z.array(projectedPropertyCoverageSchema),
  })
  .superRefine((shape, context) => {
    const fieldPaths = shape.fields.map(({ path }) => path);
    if (new Set(fieldPaths).size !== fieldPaths.length)
      context.addIssue({
        code: "custom",
        path: ["fields"],
        message: "Projected return field paths must be unique",
      });
    const coveragePaths = shape.property_coverage.map(({ path }) => path);
    if (new Set(coveragePaths).size !== coveragePaths.length)
      context.addIssue({
        code: "custom",
        path: ["property_coverage"],
        message: "Projected property coverage paths must be unique",
      });
  });

/** Strict graph-observation payload produced by static return-shape recovery. */
export const projectedExportReturnShapesSchema = z
  .strictObject({
    semantic_role: z.literal("export-return-shapes"),
    module_path: selectorTextSchema,
    exported_name: selectorTextSchema,
    callable_id: textSchema,
    callable_kind: z.enum(["function", "class", "method"]),
    static_return_shapes: z.array(projectedReturnShapeSchema),
    return_shape_coverage: z.strictObject({
      status: z.enum(["complete", "partial", "truncated"]),
      retained_return_sites: z.number().int().min(0),
      omitted_return_sites: z.number().int().min(0).nullable(),
      omitted_fields: z.number().int().min(0),
      omitted_property_coverage: z.number().int().min(0),
      projection_complete: z.boolean(),
    }),
  })
  .superRefine((projection, context) => {
    if (
      projection.return_shape_coverage.retained_return_sites !==
      projection.static_return_shapes.length
    )
      context.addIssue({
        code: "custom",
        path: ["return_shape_coverage", "retained_return_sites"],
        message: "Retained return-site count must match projected shapes",
      });
  });

const exportCandidateSchema = z.strictObject({
  node_id: nodeIdSchema,
  module_path: selectorTextSchema,
  export_name: selectorTextSchema,
  matches_requested_module: z.boolean(),
  matches_requested_export: z.boolean(),
});

const selectorResultShape = {
  evidence_id: evidenceIdSchema,
  graph_id: graphIdSchema,
  requested_module_path: selectorTextSchema,
  requested_export_name: selectorTextSchema,
  candidates: z.array(exportCandidateSchema),
  omitted_candidates: z.number().int().min(0),
};
const selectorResultSchema = z.union([
  z.strictObject({
    ...selectorResultShape,
    status: z.literal("selected"),
    selected_node_id: nodeIdSchema,
  }),
  z.strictObject({
    ...selectorResultShape,
    status: z.enum(["missing", "ambiguous"]),
    selected_node_id: z.null(),
  }),
  z.strictObject({
    ...selectorResultShape,
    status: z.literal("unavailable"),
    selected_node_id: nodeIdSchema.nullable(),
  }),
]);

const valueAvailabilitySchema = z.discriminatedUnion("availability", [
  z.strictObject({ availability: z.literal("absent") }),
  z.strictObject({
    availability: z.literal("literal"),
    value: semanticPrimitiveSchema,
  }),
  z.strictObject({
    availability: z.literal("union"),
    values: z.array(semanticPrimitiveSchema).min(1),
  }),
  z.strictObject({
    availability: z.literal("unknown"),
    reason: textSchema,
  }),
]);

const discriminantSchema = z.strictObject({
  path: jsonPointerSchema,
  value: semanticPrimitiveSchema,
});

const comparisonChangeSchema = z.strictObject({
  change_id: prefixedDigestSchema("jesc_change"),
  status: z.enum(["added", "removed", "changed", "unknown"]),
  path: jsonPointerSchema,
  discriminant: discriminantSchema.nullable(),
  left: valueAvailabilitySchema,
  right: valueAvailabilitySchema,
  left_source_range: sourceRangeSchema.nullable(),
  right_source_range: sourceRangeSchema.nullable(),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(textSchema),
});

/** Static export-return comparison with explicit unknown semantics. */
export const javaScriptExportShapeComparisonResultSchema = z.strictObject({
  comparison_id: prefixedDigestSchema("jesc"),
  left: selectorResultSchema,
  right: selectorResultSchema,
  summary: z.strictObject({
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    changed: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  changes: z.array(comparisonChangeSchema),
  coverage: z.strictObject({
    status: z.enum(["complete-within-inputs", "partial", "truncated"]),
    left_graph_status: z.enum([
      "complete",
      "partial",
      "unknown",
      "unavailable",
    ]),
    right_graph_status: z.enum([
      "complete",
      "partial",
      "unknown",
      "unavailable",
    ]),
    paired_variants: z.number().int().min(0),
    unpaired_left_variants: z.number().int().min(0),
    unpaired_right_variants: z.number().int().min(0),
    omitted_left_variants: z.number().int().min(0),
    omitted_right_variants: z.number().int().min(0),
    left_source_omitted_variants: z.number().int().min(0).nullable(),
    right_source_omitted_variants: z.number().int().min(0).nullable(),
    left_omitted_fields: z.number().int().min(0),
    right_omitted_fields: z.number().int().min(0),
    left_omitted_property_coverage: z.number().int().min(0),
    right_omitted_property_coverage: z.number().int().min(0),
    omitted_candidates: z.number().int().min(0),
    omitted_changes: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(textSchema),
});

export type ProjectedExportReturnShapes = z.output<
  typeof projectedExportReturnShapesSchema
>;
export type JavaScriptExportShapeComparisonResult = z.output<
  typeof javaScriptExportShapeComparisonResultSchema
>;
export type JavaScriptExportShapeComparisonChange = z.output<
  typeof comparisonChangeSchema
>;
