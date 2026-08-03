import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { applyToolInputJsonSchemaOverride } from "../../../src/contracts/toolSchemaJsonOverrides.js";
import { z } from "zod";

const publicInputSchema = (name: string) => {
  const contract = TOOL_CONTRACTS.find((item) => item.name === name);
  if (contract === undefined) throw new Error(`Missing contract: ${name}`);
  return applyToolInputJsonSchemaOverride(
    name,
    z.toJSONSchema(contract.inputSchema, {
      target: "draft-07",
      unrepresentable: "any",
    }),
  );
};

describe("public tool schema refinements", () => {
  it("requires complete web capture pairs and Evidence sources", () => {
    expect(publicInputSchema("compare_web_captures")).toMatchObject({
      oneOf: [
        {
          required: ["before", "after"],
          not: {
            anyOf: [
              { required: ["before_scenario"] },
              { required: ["after_scenario"] },
            ],
          },
        },
        {
          required: ["before_scenario", "after_scenario"],
          not: {
            anyOf: [{ required: ["before"] }, { required: ["after"] }],
          },
        },
      ],
    });
    expect(publicInputSchema("trace_application_feature")).toMatchObject({
      oneOf: [
        { required: ["application"] },
        { required: ["application_evidence_id"] },
      ],
    });
  });

  it("publishes sensitive approval dependencies and exact readiness stages", () => {
    expect(
      JSON.stringify(publicInputSchema("inspect_electron_page")),
    ).toContain('"source_capture_approved"');
    const readiness = publicInputSchema("evaluate_reconstruction_readiness");
    expect(readiness).toMatchObject({
      allOf: [
        {
          properties: {
            stages: {
              allOf: expect.arrayContaining([
                expect.objectContaining({ minContains: 1, maxContains: 1 }),
              ]),
            },
          },
        },
      ],
    });
    expect(JSON.stringify(readiness)).toContain('"minContains":1');

    const bundleSchema = JSON.stringify(
      publicInputSchema("analyze_web_bundle"),
    );
    expect(bundleSchema).toContain('"include_console_text"');
    expect(bundleSchema).toContain('"console_text_approved"');
    expect(bundleSchema).toContain('"include_json_body_shapes"');
    expect(bundleSchema).toContain('"json_body_schema_approved"');
    expect(bundleSchema).toContain('"include_websocket_shapes"');
    expect(bundleSchema).toContain('"websocket_shape_approved"');
  });

  it("requires exactly two export-shape Evidence links", () => {
    const contract = TOOL_CONTRACTS.find(
      ({ name }) => name === "compare_javascript_export_shapes",
    );
    if (contract === undefined)
      throw new Error("Missing export comparison contract");
    expect(
      JSON.stringify(
        z.toJSONSchema(contract.outputSchema, {
          target: "draft-07",
          unrepresentable: "any",
        }),
      ),
    ).toContain('"minItems":2');
  });

  it("requires exactly one source for source-to-bundle comparison", () => {
    expect(publicInputSchema("compare_source_to_bundle")).toMatchObject({
      oneOf: [
        { required: ["application"] },
        { required: ["application_evidence_id"] },
      ],
    });
  });
});
