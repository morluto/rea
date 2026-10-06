import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "../domain/javascriptSemanticAnalysis.js";
import { completeApplicationCoverage } from "../domain/javascriptApplicationEvidenceSchemas.js";
import { projectJavaScriptExportReturnShapes } from "./JavaScriptReturnShapeProjection.js";

const projectReturns = (body: string) => {
  const ir = analyzeJavaScriptSemantics(`export function result() { ${body} }`);
  const link = ir.moduleLinks.find(
    ({ exportedName }) => exportedName === "result",
  );
  if (link === undefined) throw new Error("Expected the result export");
  const projected = projectJavaScriptExportReturnShapes({
    ir,
    link,
    modulePath: "fixture.js",
    baseCoverage: completeApplicationCoverage(),
  });
  if (projected === null) throw new Error("Expected exported return shapes");
  return projected;
};

const unknownBranchField = {
  path: "",
  state: "unknown",
  value: null,
  reason: "Branches have incompatible values.",
};

describe("exported primitive union return shapes", () => {
  const conditionalCases = [
    "missing",
    "unsupported()",
    '({ key: "value" })',
    '["value"]',
    '+"invalid"',
  ].flatMap((other) => [
    `condition ? (choice ? "one" : "two") : ${other}`,
    `condition ? ${other} : (choice ? "one" : "two")`,
  ]);
  const logicalCases = [
    { operator: "||", known: '(choice ? "" : "one")' },
    { operator: "&&", known: '(choice ? 0 : "one")' },
    { operator: "??", known: '(choice ? null : "one")' },
  ].flatMap(({ operator, known }) => [
    `${known} ${operator} missing`,
    `missing ${operator} ${known}`,
  ]);

  it.each([...conditionalCases, ...logicalCases])(
    "projects an unknown field instead of a definite union for %s",
    (expression) => {
      const projected = projectReturns(`return ${expression};`);

      expect(projected.properties.static_return_shapes).toEqual([
        {
          source_range: expect.any(Object),
          value_status: "ambiguous",
          fields: [unknownBranchField],
          property_coverage: [],
        },
      ]);
      // Complete return-site collection does not make its values known.
      expect(projected.properties.return_shape_coverage).toEqual({
        status: "complete",
        retained_return_sites: 1,
        omitted_return_sites: 0,
        omitted_fields: 0,
        omitted_property_coverage: 0,
        projection_complete: true,
      });
      expect(projected.coverage).toEqual(completeApplicationCoverage());
      expect(projected.limitations).toContain(
        "Return shapes are inferred from inert syntax and do not prove runtime behavior.",
      );
    },
  );

  it("keeps an incompatible object field unknown beside a known literal", () => {
    const projected = projectReturns(`
      return {
        kind: "result",
        value: condition ? (choice ? "one" : "two") : missing,
      };
    `);
    expect(projected.properties.static_return_shapes).toEqual([
      {
        source_range: expect.any(Object),
        value_status: "object",
        fields: [
          { path: "/kind", state: "literal", value: "result", reason: null },
          { ...unknownBranchField, path: "/value" },
        ],
        property_coverage: [{ path: "", status: "complete", omitted: 0 }],
      },
    ]);
  });

  it("retains valid nested unions, duplicates, and null alternatives", () => {
    const projected = projectReturns(`
      return condition
        ? (choice ? "two" : "one")
        : (other ? "one" : null);
    `);
    expect(projected.properties.static_return_shapes).toEqual([
      {
        source_range: expect.any(Object),
        value_status: "union",
        fields: [
          {
            path: "",
            state: "union",
            value: [null, "one", "two"],
            reason: null,
          },
        ],
        property_coverage: [],
      },
    ]);
  });

  it("preserves three independent direct returns without merging their values", () => {
    const projected = projectReturns(`
      if (condition) return choice ? "one" : "two";
      if (other) return missing;
      return { kind: "object" };
    `);
    expect(projected.properties.static_return_shapes).toEqual([
      {
        source_range: expect.any(Object),
        value_status: "union",
        fields: [
          { path: "", state: "union", value: ["one", "two"], reason: null },
        ],
        property_coverage: [],
      },
      {
        source_range: expect.any(Object),
        value_status: "unknown",
        fields: [
          {
            path: "",
            state: "unknown",
            value: null,
            reason: "Unbound identifier missing.",
          },
        ],
        property_coverage: [],
      },
      {
        source_range: expect.any(Object),
        value_status: "object",
        fields: [
          { path: "/kind", state: "literal", value: "object", reason: null },
        ],
        property_coverage: [{ path: "", status: "complete", omitted: 0 }],
      },
    ]);
    expect(projected.properties.return_shape_coverage).toMatchObject({
      status: "complete",
      retained_return_sites: 3,
      omitted_return_sites: 0,
      projection_complete: true,
    });
  });
});
