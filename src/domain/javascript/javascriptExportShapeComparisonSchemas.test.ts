import { expect, it } from "vitest";

import {
  javaScriptExportShapeComparisonChangeSchema,
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

it("rejects a comparison change object missing presence", () => {
  const digest = "a".repeat(64);
  const change = {
    change_id: `jesc_change_${digest}`,
    status: "added",
    path: "/total",
    discriminant: { path: "/kind", value: "results" },
    left: { availability: "absent" },
    right: {
      availability: "unknown",
      reason: "Static field value is unknown.",
    },
    left_source_range: {
      start: { line: 4, column: 9 },
      end: { line: 4, column: 48 },
    },
    right_source_range: {
      start: { line: 4, column: 9 },
      end: { line: 4, column: 62 },
    },
    evidence_links: [`ev_${digest}`, `ev_${"b".repeat(64)}`],
    limitations: [],
  };
  expect(
    javaScriptExportShapeComparisonChangeSchema.safeParse(change).success,
  ).toBe(false);
  expect(
    javaScriptExportShapeComparisonChangeSchema.safeParse({
      ...change,
      presence: { left: "absent", right: "present" },
    }).success,
  ).toBe(true);
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
