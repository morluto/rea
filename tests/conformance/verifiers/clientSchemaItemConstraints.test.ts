import { expect, it } from "vitest";
import { arrayItemSchemaError } from "../../fixtures/mcpClientSchemaConstraints.js";

it("checks client array requirements when a reference selects literal-held schemas", () => {
  const literal = { examples: [{ type: "array" }] };
  expect(arrayItemSchemaError(literal, "tool")).toBeUndefined();
  expect(
    arrayItemSchemaError({ ...literal, $ref: "#/examples/0" }, "tool"),
  ).toBe("tool.examples[0]: tool parameters array type must have items");
  expect(
    arrayItemSchemaError(
      {
        $ref: "#/examples/0",
        examples: [{ type: "array", items: { type: "string" } }],
      },
      "tool",
    ),
  ).toBeUndefined();
});
