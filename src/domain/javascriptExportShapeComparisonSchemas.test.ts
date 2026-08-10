import { expect, it } from "vitest";

import { projectedExportReturnShapesSchema } from "./javascriptExportShapeComparisonSchemas.js";

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
