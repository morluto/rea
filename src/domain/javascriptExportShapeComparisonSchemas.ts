import { z } from "zod";

import { evidenceSchema } from "./evidence.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const graphIdSchema = z.string().regex(/^jag_[a-f0-9]{64}$/u);
const nodeIdSchema = z.string().regex(/^jag_node_[a-f0-9]{64}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);
const selectorTextSchema = z.string().min(1).max(4_096);
const semanticPrimitiveSchema = z.union([
  z.string().max(4_096),
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
  .max(4_096)
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

const comparisonLimitsSchema = z.strictObject({
  max_candidate_exports: z.number().int().min(1).max(1_000).default(100),
  max_return_variants: z.number().int().min(1).max(1_000).default(128),
  max_changes: z.number().int().min(1).max(10_000).default(1_000),
});

/** Two authenticated application graphs, exact export selectors, and bounds. */
export const compareJavaScriptExportShapesInputSchema = z
  .strictObject({
    left: evidenceSchema,
    right: evidenceSchema,
    left_module_path: selectorTextSchema,
    left_export_name: selectorTextSchema,
    right_module_path: selectorTextSchema,
    right_export_name: selectorTextSchema,
    limits: comparisonLimitsSchema.default({
      max_candidate_exports: 100,
      max_return_variants: 128,
      max_changes: 1_000,
    }),
    unknown_registry_approved: z.literal(true).optional(),
  })
  .superRefine((input, context) => {
    if (input.left.evidence_id === input.right.evidence_id)
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "JavaScript export shape Evidence must be distinct",
      });
  });

const projectedReturnFieldSchema = z
  .strictObject({
    path: jsonPointerSchema,
    state: z.enum(["literal", "union", "unknown"]),
    value: z.union([
      semanticPrimitiveSchema,
      z.array(semanticPrimitiveSchema).min(1).max(32),
    ]),
    reason: boundedTextSchema.nullable(),
  })
  .superRefine((field, context) => {
    if (field.state === "union" && !Array.isArray(field.value))
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Union return fields require a primitive value array",
      });
    if (field.state !== "union" && Array.isArray(field.value))
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Only union return fields may contain a value array",
      });
    if (field.state === "unknown" && field.reason === null)
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Unknown return fields require a reason",
      });
    if (field.state !== "unknown" && field.reason !== null)
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Known return fields cannot carry an unknown reason",
      });
  });

const projectedPropertyCoverageSchema = z.strictObject({
  path: jsonPointerSchema,
  status: z.enum(["complete", "partial"]),
  omitted: z.number().int().min(0).nullable(),
});

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
      "limit-reached",
    ]),
    fields: z.array(projectedReturnFieldSchema).max(64),
    property_coverage: z.array(projectedPropertyCoverageSchema).max(64),
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
    callable_id: boundedTextSchema,
    callable_kind: z.enum(["function", "class", "method"]),
    static_return_shapes: z.array(projectedReturnShapeSchema).max(32),
    return_shape_coverage: z.strictObject({
      status: z.enum(["complete", "partial", "truncated"]),
      retained_return_sites: z.number().int().min(0).max(32),
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

const selectorResultSchema = z.strictObject({
  evidence_id: evidenceIdSchema,
  graph_id: graphIdSchema,
  requested_module_path: selectorTextSchema,
  requested_export_name: selectorTextSchema,
  status: z.enum(["selected", "missing", "ambiguous", "unavailable"]),
  selected_node_id: nodeIdSchema.nullable(),
  candidates: z.array(exportCandidateSchema).max(1_000),
  omitted_candidates: z.number().int().min(0),
});

const valueAvailabilitySchema = z.discriminatedUnion("availability", [
  z.strictObject({ availability: z.literal("absent") }),
  z.strictObject({
    availability: z.literal("literal"),
    value: semanticPrimitiveSchema,
  }),
  z.strictObject({
    availability: z.literal("union"),
    values: z.array(semanticPrimitiveSchema).min(1).max(32),
  }),
  z.strictObject({
    availability: z.literal("unknown"),
    reason: boundedTextSchema,
  }),
]);

const discriminantSchema = z.strictObject({
  path: jsonPointerSchema,
  value: semanticPrimitiveSchema,
});

const comparisonChangeSchema = z.strictObject({
  change_id: z.string().regex(/^jesc_change_[a-f0-9]{64}$/u),
  status: z.enum(["added", "removed", "changed", "unknown"]),
  path: jsonPointerSchema,
  discriminant: discriminantSchema.nullable(),
  left: valueAvailabilitySchema,
  right: valueAvailabilitySchema,
  left_source_range: sourceRangeSchema.nullable(),
  right_source_range: sourceRangeSchema.nullable(),
  evidence_links: z.tuple([evidenceIdSchema, evidenceIdSchema]),
  limitations: z.array(boundedTextSchema).max(20),
});

/** Bounded static export-return comparison with explicit unknown semantics. */
export const javaScriptExportShapeComparisonResultSchema = z.strictObject({
  schema_version: z.literal(1),
  comparison_id: z.string().regex(/^jesc_[a-f0-9]{64}$/u),
  left: selectorResultSchema,
  right: selectorResultSchema,
  summary: z.strictObject({
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    changed: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  changes: z.array(comparisonChangeSchema).max(10_000),
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
  evidence_links: z.tuple([evidenceIdSchema, evidenceIdSchema]),
  limitations: z.array(boundedTextSchema).max(1_000),
  runtime_validation: z.strictObject({
    recommended_tool: z.literal("run_controlled_replay"),
    automatically_started: z.literal(false),
    required_for: z.literal("runtime-semantics"),
  }),
});

export type CompareJavaScriptExportShapesInput = z.output<
  typeof compareJavaScriptExportShapesInputSchema
>;
export type ProjectedExportReturnShapes = z.output<
  typeof projectedExportReturnShapesSchema
>;
export type JavaScriptExportShapeComparisonResult = z.output<
  typeof javaScriptExportShapeComparisonResultSchema
>;
export type JavaScriptExportShapeComparisonChange = z.output<
  typeof comparisonChangeSchema
>;
