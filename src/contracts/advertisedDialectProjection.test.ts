import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { advertisedInputDialectViolations } from "./advertisedDialect.js";
import { projectToAdvertisedDialect } from "./advertisedDialectProjection.js";

const project = (properties: Record<string, unknown>, root = {}) =>
  projectToAdvertisedDialect({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    additionalProperties: false,
    ...root,
  });

/** Every canonical-valid value stays valid; the projection only widens. */
const expectWidening = (
  canonical: Record<string, unknown>,
  values: readonly unknown[],
) => {
  const { schema } = project({ value: canonical });
  const ajv = new Ajv2020({ strict: false });
  const validateCanonical = ajv.compile({
    type: "object",
    properties: { value: canonical },
  });
  const validateAdvertised = ajv.compile(schema);
  for (const value of values)
    if (validateCanonical({ value }))
      expect(validateAdvertised({ value }), JSON.stringify(value)).toBe(true);
  return schema.properties as Record<string, unknown>;
};

describe("portable advertised dialect projection", () => {
  it.each([
    ["string const", { const: "a" }, { type: "string", enum: ["a"] }],
    ["empty string const", { type: "string", const: "" }, { type: "string" }],
    ["boolean const", { type: "boolean", const: true }, { type: "boolean" }],
    ["numeric enum", { enum: [1, 2] }, { type: "integer" }],
    [
      "integer exclusive bound",
      { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 10 },
      { type: "integer", minimum: 1, maximum: 9 },
    ],
    [
      "number exclusive bound",
      { type: "number", exclusiveMinimum: 0.5 },
      { type: "number", minimum: 0.5 },
    ],
    [
      "pattern-only allOf members",
      { type: "string", allOf: [{ pattern: "^a" }, { pattern: "b$" }] },
      { type: "string", pattern: "^a" },
    ],
    [
      "string literal union",
      { anyOf: [{ type: "string", enum: ["a", "b"] }, { const: "c" }] },
      { type: "string", enum: ["a", "b", "c"] },
    ],
    [
      "homogeneous tuple",
      {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "number" }],
        minItems: 2,
        maxItems: 2,
      },
      { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    ],
    [
      "client-unsafe bounds",
      { type: "string", minLength: 1, maxLength: 4096, format: "uuid" },
      { type: "string", minLength: 1 },
    ],
    [
      "open map",
      {
        type: "object",
        propertyNames: { pattern: "^k" },
        additionalProperties: { type: "string" },
        minProperties: 1,
      },
      { type: "object" },
    ],
  ])("projects a %s exactly or wider", (_label, canonical, expected) => {
    const properties = expectWidening(canonical, [
      "a",
      "c",
      "",
      true,
      0,
      1,
      2,
      5,
      0.5,
      10,
      [1, 2],
      { k: "v" },
      "ab",
    ]);
    expect(properties.value).toEqual(expected);
  });

  it("widens oneOf, types the union and keeps the null branch of nullable values", () => {
    const { schema } = project({
      view: {
        oneOf: [
          { type: "object", properties: { kind: { const: "a" } } },
          { type: "object", properties: { kind: { const: "b" } } },
        ],
      },
      limit: { type: ["integer", "null"], minimum: 1 },
    });
    expect(schema.properties).toEqual({
      view: {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: { kind: { type: "string", enum: ["a"] } },
          },
          {
            type: "object",
            properties: { kind: { type: "string", enum: ["b"] } },
          },
        ],
      },
      limit: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    });
    // Nullable values are the one construct left outside the dialect.
    expect(
      advertisedInputDialectViolations({ name: "probe", inputSchema: schema }),
    ).toEqual([
      {
        tool: "probe",
        schema: "input",
        path: "$.properties.limit",
        rule: "type",
        detail: "nullable",
      },
    ]);
  });

  it("moves the root description and dropped cross-field constraints to tool guidance", () => {
    const projection = project(
      {
        table: { type: "string" },
        row_limit: { type: "integer" },
        ids: { type: "array", items: { type: "string" }, uniqueItems: true },
        name: { type: "string", not: { enum: ["reserved"] } },
      },
      {
        description: "Root guidance.",
        dependentRequired: { row_limit: ["table"] },
        if: { required: ["table"] },
        then: { required: ["row_limit"] },
      },
    );
    expect(projection.guidance).toEqual([
      "Root guidance.",
      "When row_limit is provided, also provide table.",
      "`ids` entries must be distinct.",
      '`name` must not be "reserved".',
    ]);
    expect(projection.schema).not.toHaveProperty("description");
    expect(
      advertisedInputDialectViolations({
        name: "probe",
        inputSchema: projection.schema,
      }),
    ).toEqual([]);
  });

  it("bounds nested descriptions without splitting a surrogate pair", () => {
    const description = `${"x".repeat(1022)}😀tail`;
    const { schema } = project({ value: { type: "string", description } });
    const value = (schema.properties as Record<string, Record<string, string>>)
      .value!;
    expect(value.description!.length).toBeLessThanOrEqual(1024);
    expect(value.description!.endsWith("x…")).toBe(true);
  });
});
