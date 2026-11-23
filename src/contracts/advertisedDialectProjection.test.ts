import { Ajv2020 } from "ajv/dist/2020.js";
import { addFormats } from "@modelcontextprotocol/client/validators/ajv";
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
  addFormats(ajv);
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

it("does not move a closed allOf member's property scope onto another member", () => {
  expectWidening(
    {
      allOf: [
        { type: "object", properties: { a: { type: "string" } } },
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          additionalProperties: false,
        },
      ],
    },
    [{ a: "x", b: "y" }],
  );
});

it("does not move an allOf member's tuple tail beside other positions", () => {
  expectWidening(
    {
      type: "array",
      allOf: [
        { prefixItems: [{ type: "number" }] },
        { prefixItems: [{ type: "number" }, { type: "string" }], items: false },
      ],
    },
    [[1, "ok"]],
  );
});

it("does not move a single union branch's closure onto the parent's properties", () => {
  expectWidening(
    {
      type: "object",
      properties: { a: { type: "string" } },
      anyOf: [
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          additionalProperties: false,
        },
      ],
    },
    [{ a: "x", b: "y" }],
  );
});

it("leaves objects open when dropped pattern properties admit names", () => {
  expectWidening(
    {
      type: "object",
      patternProperties: { "^b$": { type: "string" } },
      additionalProperties: false,
    },
    [{ b: "ok" }],
  );
});

it("does not make a union branch's omitted rule into global guidance", () => {
  const { guidance } = project({
    value: {
      anyOf: [
        { type: "string", not: { enum: ["reserved"] } },
        { type: "string", enum: ["reserved"] },
      ],
    },
  });
  expect(guidance.join(" ")).not.toContain('must not be "reserved"');
});

it("keeps a property named __proto__ as an own property", () => {
  const canonical = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}',
  ) as Record<string, unknown>;
  const { schema } = projectToAdvertisedDialect(canonical);
  const properties = schema.properties as Record<string, unknown>;
  expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
  expect(Object.hasOwn(properties, "__proto__")).toBe(true);
  expect(properties.__proto__).toEqual({ type: "string" });
  expect(schema).toMatchObject({
    required: ["__proto__"],
    additionalProperties: false,
  });
});

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
      {
        type: "string",
        allOf: [{ pattern: "^a[a-z]*$" }, { pattern: "^[a-z]*b$" }],
      },
      { type: "string", pattern: "^a[a-z]*$" },
    ],
    [
      "pattern in its portable form",
      { type: "string", pattern: "^\\d+$" },
      { type: "string", pattern: "^[0-9]+$" },
    ],
    [
      "pattern without a portable form",
      { type: "string", pattern: "^😀$" },
      { type: "string" },
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
          {
            type: "object",
            properties: {
              kind: { const: "b" },
              extra: { type: "string" },
            },
          },
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
            properties: {
              kind: { type: "string", enum: ["b"] },
              extra: { type: "string" },
            },
          },
        ],
      },
      limit: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    });
    // A nullable value is a typed branch or null, within the dialect.
    expect(
      advertisedInputDialectViolations({ name: "probe", inputSchema: schema }),
    ).toEqual([]);
  });
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

it("names the literals of a dropped enum or const in tool guidance", () => {
  const projection = project({
    bits: { type: "number", enum: [4, 8, 16, 32, 64] },
    level: { enum: [1, 2] },
    confirm: { type: "boolean", const: true },
    separator: { type: "string", enum: ["", ","] },
    options: {
      type: "object",
      properties: { mode: { type: "integer", const: 0 } },
    },
    // A portable string enum stays in the schema and needs no sentence.
    kind: { type: "string", enum: ["a", "b"] },
  });
  expect(projection.guidance).toEqual([
    "`bits` must be 4, 8, 16, 32 or 64.",
    "`level` must be 1 or 2.",
    "`confirm` must be true.",
    '`separator` must be "" or ",".',
    "`options.mode` must be 0.",
  ]);
  expect(projection.schema.properties).toMatchObject({
    bits: { type: "number" },
    level: { type: "integer" },
    kind: { type: "string", enum: ["a", "b"] },
  });
  expect(
    (projection.schema.properties as Record<string, unknown>).bits,
  ).not.toHaveProperty("enum");
});

it("bounds nested descriptions without splitting a surrogate pair", () => {
  const description = `${"x".repeat(1022)}😀tail`;
  const { schema } = project({ value: { type: "string", description } });
  const value = (schema.properties as Record<string, Record<string, string>>)
    .value!;
  expect(value.description!.length).toBeLessThanOrEqual(1024);
  expect(value.description!.endsWith("x…")).toBe(true);
});

describe("product-union factoring and safe-integer bounds", () => {
  it("factors matching object union branches that differ only on one string enum", () => {
    const { schema } = project({
      target: {
        anyOf: [
          {
            type: "object",
            properties: { kind: { const: "whole" } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "volume" },
              offset: { type: "integer", minimum: 0 },
            },
            required: ["kind", "offset"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "section" },
              offset: { type: "integer", minimum: 0 },
            },
            required: ["kind", "offset"],
            additionalProperties: false,
          },
        ],
      },
      collapsed: {
        oneOf: [
          {
            type: "object",
            properties: { mode: { const: "fast" }, limit: { type: "integer" } },
            required: ["mode"],
          },
          {
            type: "object",
            properties: { mode: { const: "deep" }, limit: { type: "integer" } },
            required: ["mode"],
          },
        ],
      },
    });
    expect(schema.properties).toEqual({
      target: {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: { kind: { type: "string", enum: ["whole"] } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["volume", "section"] },
              offset: { type: "integer", minimum: 0 },
            },
            required: ["kind", "offset"],
            additionalProperties: false,
          },
        ],
      },
      collapsed: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "deep"] },
          limit: { type: "integer" },
        },
        required: ["mode"],
      },
    });
    expect(
      advertisedInputDialectViolations({ name: "probe", inputSchema: schema }),
    ).toEqual([]);
  });

  it("keeps branches separate when required, closure, descriptions, or multiple fields differ", () => {
    const { schema } = project({
      kept_separate: {
        anyOf: [
          {
            type: "object",
            properties: {
              a: { const: "x", description: "First" },
              b: { const: "1" },
            },
            required: ["a", "b"],
          },
          {
            type: "object",
            properties: {
              a: { const: "y", description: "Second" },
              b: { const: "1" },
            },
            required: ["a", "b"],
          },
          {
            type: "object",
            properties: {
              a: { const: "z", description: "First" },
              b: { const: "2" },
            },
            required: ["a", "b"],
          },
        ],
      },
    });
    const branches = (
      (schema.properties as Record<string, Record<string, unknown>>)
        .kept_separate!.anyOf as unknown[]
    ).length;
    expect(branches).toBe(3);
  });

  it("omits redundant JavaScript safe-integer bounds while keeping real bounds", () => {
    const { schema } = project({
      unbounded_int: {
        type: "integer",
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      non_negative: {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      bounded: {
        type: "integer",
        minimum: 1,
        maximum: 100,
      },
    });
    expect(schema.properties).toEqual({
      unbounded_int: { type: "integer" },
      non_negative: { type: "integer", minimum: 0 },
      bounded: { type: "integer", minimum: 1, maximum: 100 },
    });
  });
});
