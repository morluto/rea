import { expect, it } from "vitest";

import {
  javaScriptExportShapeComparisonResultSchema,
  projectedExportReturnShapesSchema,
} from "./javascriptExportShapeComparisonSchemas.js";

const projectionWithField = (field: unknown) => ({
  semantic_role: "export-return-shapes",
  module_path: "index.js",
  exported_name: "render",
  callable_id: "callable:render",
  callable_kind: "function",
  static_return_shapes: [
    {
      source_range: {
        start: { line: 1, column: 0 },
        end: { line: 1, column: 10 },
      },
      value_status: "unknown",
      fields: [field],
      property_coverage: [],
    },
  ],
  return_shape_coverage: {
    status: "partial",
    retained_return_sites: 1,
    omitted_return_sites: null,
    omitted_fields: 0,
    omitted_property_coverage: 0,
    projection_complete: true,
  },
});

it("parses projected fields into literal, union, or unknown values", () => {
  expect(
    projectedExportReturnShapesSchema.safeParse(
      projectionWithField({
        path: "/kind",
        state: "unknown",
        value: "invented",
        reason: "Dynamic property",
      }),
    ).success,
  ).toBe(false);
  expect(
    projectedExportReturnShapesSchema.safeParse(
      projectionWithField({
        path: "/kind",
        state: "union",
        value: ["success", "failure"],
        reason: null,
      }),
    ).success,
  ).toBe(true);
});

it("accepts every projected return site and field without presentation caps", () => {
  const fields = Array.from({ length: 65 }, (_, index) => ({
    path: `/field-${String(index)}`,
    state: "literal",
    value: index,
    reason: null,
  }));
  const propertyCoverage = fields.map(({ path }) => ({
    path,
    status: "complete",
    omitted: 0,
  }));
  const shapes = Array.from({ length: 33 }, () => ({
    source_range: {
      start: { line: 1, column: 0 },
      end: { line: 1, column: 10 },
    },
    value_status: "object",
    fields,
    property_coverage: propertyCoverage,
  }));

  expect(
    projectedExportReturnShapesSchema.parse({
      ...projectionWithField(fields[0]),
      static_return_shapes: shapes,
      return_shape_coverage: {
        status: "complete",
        retained_return_sites: shapes.length,
        omitted_return_sites: 0,
        omitted_fields: 0,
        omitted_property_coverage: 0,
        projection_complete: true,
      },
    }).static_return_shapes,
  ).toHaveLength(33);
});

it("accepts complete candidate and change inventories without page ceilings", () => {
  const evidenceId = `ev_${"a".repeat(64)}`;
  const graphId = `jag_${"b".repeat(64)}`;
  const selector = {
    evidence_id: evidenceId,
    graph_id: graphId,
    requested_module_path: "index.js",
    requested_export_name: "render",
    candidates: Array.from({ length: 1_001 }, (_, index) => ({
      node_id: `jag_node_${index.toString(16).padStart(64, "0")}`,
      module_path: "index.js",
      export_name: "render",
      matches_requested_module: true,
      matches_requested_export: true,
    })),
    omitted_candidates: 0,
    status: "missing",
    selected_node_id: null,
  };
  const changes = Array.from({ length: 10_001 }, (_, index) => ({
    change_id: `jesc_change_${index.toString(16).padStart(64, "0")}`,
    status: "unknown",
    path: `/field-${String(index)}`,
    discriminant: null,
    left: { availability: "absent" },
    right: { availability: "absent" },
    left_source_range: null,
    right_source_range: null,
    evidence_links: [evidenceId, `ev_${"c".repeat(64)}`],
    limitations: [],
  }));

  expect(
    javaScriptExportShapeComparisonResultSchema.parse({
      comparison_id: `jesc_${"d".repeat(64)}`,
      left: selector,
      right: { ...selector, graph_id: `jag_${"e".repeat(64)}` },
      summary: { added: 0, removed: 0, changed: 0, unknown: changes.length },
      changes,
      coverage: {
        status: "complete-within-inputs",
        left_graph_status: "complete",
        right_graph_status: "complete",
        paired_variants: 0,
        unpaired_left_variants: 0,
        unpaired_right_variants: 0,
        omitted_left_variants: 0,
        omitted_right_variants: 0,
        left_source_omitted_variants: 0,
        right_source_omitted_variants: 0,
        left_omitted_fields: 0,
        right_omitted_fields: 0,
        left_omitted_property_coverage: 0,
        right_omitted_property_coverage: 0,
        omitted_candidates: 0,
        omitted_changes: 0,
      },
      evidence_links: [evidenceId, `ev_${"c".repeat(64)}`],
      limitations: [],
    }).changes,
  ).toHaveLength(10_001);
});
