import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import { presentInputJsonSchema } from "./inputSchemaPresentation.js";

it.each(["draft-2020-12", "draft-07"] as const)(
  "summarizes only declared observation schemas, preserving literal data in %s",
  (target) => {
    const literal = {
      type: "object",
      "x-rea-complete-observation": true,
      properties: { producer_data: { type: "string" } },
    };
    const controls = {
      type: "object",
      properties: { match: { type: "string", minLength: 1 } },
      required: ["match"],
      additionalProperties: false,
    };
    const canonical = {
      $schema:
        target === "draft-07"
          ? "http://json-schema.org/draft-07/schema#"
          : "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        observation: {
          type: "object",
          description: "Complete result from the producer.",
          "x-rea-complete-observation": true,
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        controls,
        literal: { const: literal },
      },
      required: ["observation", "controls", "literal"],
      additionalProperties: false,
    };
    const presented = presentInputJsonSchema(canonical, () => undefined);
    expect(presented).toHaveProperty("properties.observation", {
      type: "object",
      description: expect.stringContaining("complete canonical observation"),
    });
    expect(presented).toHaveProperty("properties.controls", controls);
    expect(presented).toHaveProperty("properties.literal.const", literal);
    const ajv =
      target === "draft-07"
        ? new Ajv({ strict: false })
        : new Ajv2020({ strict: false });
    const validate = ajv.compile(presented);
    expect(
      validate({ observation: {}, controls: { match: "x" }, literal }),
    ).toBe(true);
    expect(
      validate({ observation: "{}", controls: { match: "x" }, literal }),
    ).toBe(false);
    expect(
      validate({ observation: {}, controls: { match: "" }, literal }),
    ).toBe(false);
    expect(
      ajv.compile(canonical)({
        observation: {},
        controls: { match: "x" },
        literal,
      }),
    ).toBe(false);
  },
);

const referenceWideningCases: readonly {
  name: string;
  schema: Record<string, unknown>;
  input: unknown;
  unchanged?: boolean;
}[] = [
  {
    name: "oneOf",
    schema: {
      definitions: { off: { const: false } },
      properties: { value: { oneOf: [{ $ref: "#/definitions/off" }, {}] } },
    },
    input: { value: true },
  },
  {
    name: "not",
    schema: {
      definitions: { off: { const: false } },
      properties: { value: { not: { $ref: "#/definitions/off" } } },
    },
    input: { value: true },
  },
  {
    name: "if",
    schema: {
      definitions: { off: { const: false } },
      properties: {
        value: { if: { $ref: "#/definitions/off" }, then: false, else: true },
      },
    },
    input: { value: true },
  },
  {
    name: "chain",
    schema: {
      definitions: {
        off: { const: false },
        alias: { $ref: "#/definitions/off" },
      },
      properties: { value: { not: { $ref: "#/definitions/alias" } } },
    },
    input: { value: true },
  },
  {
    name: "recursive affected",
    schema: {
      definitions: {
        node: {
          type: "object",
          properties: {
            flag: { const: false },
            next: { $ref: "#/definitions/node" },
          },
          required: ["flag"],
        },
      },
      properties: { value: { not: { $ref: "#/definitions/node" } } },
    },
    input: { value: { flag: true } },
  },
  {
    name: "literal target unchanged",
    schema: {
      default: { predicate: { const: false } },
      properties: { value: { not: { $ref: "#/default/predicate" } } },
    },
    input: { value: true },
    unchanged: true,
  },
  {
    name: "nested resource unaffected",
    schema: {
      $id: "https://example.test/root",
      definitions: { flag: { const: false } },
      properties: {
        value: {
          $id: "child",
          definitions: { flag: { const: 7 } },
          not: { $ref: "#/definitions/flag" },
        },
      },
    },
    input: { value: 8 },
    unchanged: true,
  },
  {
    name: "recursive unaffected",
    schema: {
      definitions: {
        node: {
          type: "object",
          properties: {
            flag: { const: 7 },
            next: { $ref: "#/definitions/node" },
          },
          required: ["flag"],
        },
      },
      properties: { value: { not: { $ref: "#/definitions/node" } } },
    },
    input: { value: { flag: 8 } },
    unchanged: true,
  },
];

it.each(
  referenceWideningCases.flatMap((entry) =>
    (["draft-2020-12", "draft-07"] as const).map((dialect) => ({
      ...entry,
      dialect,
    })),
  ),
)(
  "preserves $name through scoped normalization references in $dialect",
  ({ name, schema, input, unchanged, dialect }) => {
    const canonical: Record<string, unknown> = {
      $schema:
        dialect === "draft-07"
          ? "http://json-schema.org/draft-07/schema#"
          : "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      ...schema,
    };
    const advertised = presentInputJsonSchema(canonical, () => undefined);
    const create = () =>
      dialect === "draft-07"
        ? new Ajv({ strict: false })
        : new Ajv2020({ strict: false });
    expect(create().compile(canonical)(input), `${name} canonical`).toBe(true);
    expect(create().compile(advertised)(input), `${name} advertised`).toBe(
      true,
    );
    expect(advertised.default, `${name} literal data`).toEqual(
      canonical.default,
    );
    if (unchanged)
      expect(advertised.properties, name).toEqual(canonical.properties);
  },
);

it("keeps an upper contains bound from rejecting canonical items after referenced literal widening", () => {
  const canonical = {
    type: "object",
    definitions: { off: { const: false } },
    properties: {
      values: {
        type: "array",
        contains: { $ref: "#/definitions/off" },
        minContains: 0,
        maxContains: 1,
      },
    },
  };
  const advertised = presentInputJsonSchema(canonical, () => undefined);
  const input = { values: [false, true] };
  expect(new Ajv2020({ strict: false }).compile(canonical)(input)).toBe(true);
  expect(new Ajv2020({ strict: false }).compile(advertised)(input)).toBe(true);
});

it.each([false, true])(
  "preserves conditional evaluation annotations (referenced: %s)",
  (referenced) => {
    const conditional = {
      if: { properties: { flag: { const: false } } },
      then: { properties: { extra: { type: "string" } } },
    };
    const canonical = {
      type: "object",
      definitions: { conditional },
      ...(referenced ? { $ref: "#/definitions/conditional" } : conditional),
      unevaluatedProperties: false,
    };
    const advertised = presentInputJsonSchema(canonical, () => undefined);
    const input = { flag: false, extra: "kept" };
    expect(new Ajv2020({ strict: false }).compile(canonical)(input)).toBe(true);
    expect(new Ajv2020({ strict: false }).compile(advertised)(input)).toBe(
      true,
    );
  },
);

it("retains item annotations when only the unsafe contains maximum leaves", () => {
  const canonical = {
    type: "object",
    properties: {
      values: {
        type: "array",
        contains: { const: false },
        maxContains: 1,
        unevaluatedItems: false,
      },
    },
  };
  const advertised = presentInputJsonSchema(canonical, () => undefined);
  const input = { values: [false] };
  expect(new Ajv2020({ strict: false }).compile(canonical)(input)).toBe(true);
  expect(new Ajv2020({ strict: false }).compile(advertised)(input)).toBe(true);
  expect(advertised).toHaveProperty("properties.values.contains", {
    type: "boolean",
  });
  expect(advertised).toHaveProperty(
    "properties.values.unevaluatedItems",
    false,
  );
});

it("keeps unaffected root property annotations strict when a child conditional widens", () => {
  const canonical = {
    type: "object",
    properties: {
      child: {
        if: { const: false },
        then: { type: "string" },
        else: { type: "boolean" },
      },
    },
    unevaluatedProperties: false,
  };
  const advertised = presentInputJsonSchema(canonical, () => undefined);
  const validate = new Ajv2020({ strict: false }).compile(advertised);
  expect(validate({ child: true })).toBe(true);
  expect(validate({ child: true, unknown: "reject" })).toBe(false);
  expect(advertised.unevaluatedProperties).toBe(false);
});

it.each(["draft-07", "draft-2020-12"] as const)(
  "observes reference sibling semantics in %s",
  (dialect) => {
    const canonical = {
      $schema:
        dialect === "draft-07"
          ? "http://json-schema.org/draft-07/schema#"
          : "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      definitions: {
        number: { type: "number" },
        alias: { $ref: "#/definitions/number", const: false },
      },
      properties: { value: { not: { $ref: "#/definitions/alias" } } },
    };
    const advertised = presentInputJsonSchema(canonical, () => undefined);
    const create = () =>
      dialect === "draft-07"
        ? new Ajv({ strict: false, ignoreKeywordsWithRef: true })
        : new Ajv2020({ strict: false });
    // Under the specification's draft7 rules alias is number; in2020 it accepts no value.
    const input = { value: "kept" };
    expect(create().compile(canonical)(input)).toBe(true);
    expect(create().compile(advertised)(input)).toBe(true);
    if (dialect === "draft-07")
      expect(advertised.properties).toEqual(canonical.properties);
  },
);

it.each(["draft-07", "draft-2020-12"] as const)(
  "reduces only an affected reference to opaque data in %s",
  (dialect) => {
    const literal = {
      conditional: {
        if: { $ref: "#/definitions/off" },
        then: false,
        else: true,
      },
      unaffected: { type: "string", minLength: 2 },
    };
    const canonical = {
      $schema:
        dialect === "draft-07"
          ? "http://json-schema.org/draft-07/schema#"
          : "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      definitions: { off: { const: false } },
      default: literal,
      properties: {
        value: { $ref: "#/default/conditional" },
        stable: { $ref: "#/default/unaffected" },
      },
      unevaluatedProperties: false,
    };
    const advertised = presentInputJsonSchema(canonical, () => undefined);
    const create = () =>
      dialect === "draft-07"
        ? new Ajv({ strict: false })
        : new Ajv2020({ strict: false });
    const input = { value: true, stable: "kept" };
    expect(create().compile(canonical)(input)).toBe(true);
    const validate = create().compile(advertised);
    expect(validate(input)).toBe(true);
    expect(validate({ value: true, stable: 1 })).toBe(false);
    expect(advertised.default).toEqual(literal);
    expect(advertised).toHaveProperty(
      "properties.stable",
      canonical.properties.stable,
    );
    expect(advertised).toHaveProperty(
      "properties.value.description",
      expect.stringContaining("reduced form"),
    );
    expect(advertised.unevaluatedProperties).toBe(false);
  },
);

it("does not treat unused definitions as validation dependencies", () => {
  const canonical = {
    type: "object",
    properties: {
      value: {
        not: { type: "number", definitions: { unused: { const: false } } },
      },
    },
  };
  const advertised = presentInputJsonSchema(canonical, () => undefined);
  expect(advertised).toHaveProperty("properties.value.not.type", "number");
  const validate = new Ajv2020({ strict: false }).compile(advertised);
  expect(validate({ value: "kept" })).toBe(true);
  expect(validate({ value: 1 })).toBe(false);
});
