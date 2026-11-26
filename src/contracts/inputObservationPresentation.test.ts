import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import { z } from "zod";

import { BROWSER_TOOL_CONTRACTS } from "./browserToolContracts.js";
import { presentOutputJsonSchema } from "./outputSchemaPresentation.js";
import {
  advertisedInputJsonSchema,
  COMPLETE_OBSERVATION_GUIDANCE,
  toolOutputSchemaWithMetadata,
} from "./toolSchemaMetadata.js";
import { browserCaptureComparisonRequestSchema } from "../domain/browserCaptureComparison.js";

const browserContract = (name: string) => {
  const found = BROWSER_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`Missing ${name}`);
  return found;
};

it("advertises complete observations as opaque objects only on the wire", () => {
  const comparison = browserContract("compare_web_captures");
  const advertised = advertisedInputJsonSchema(comparison);
  // Each opaque declaration is the field's own description, if any, followed
  // by the shared instruction.
  const declared = (description: string | undefined) => ({
    type: "object",
    description: [description, COMPLETE_OBSERVATION_GUIDANCE]
      .filter((text) => text !== undefined)
      .join(" "),
  });
  // Each capture is the opaque observation or its exact retained reference.
  const orRetained = (description: string | undefined) => ({
    anyOf: [
      expect.objectContaining({ required: ["kind", "evidence_id"] }),
      declared(undefined),
    ],
    description,
  });
  const passive = browserCaptureComparisonRequestSchema.options[0].shape;
  const scenario = browserCaptureComparisonRequestSchema.options[1].shape;
  expect(advertised).toHaveProperty(
    "properties.before.properties.inspection",
    orRetained(passive.before.shape.inspection.description),
  );
  expect(advertised).toHaveProperty(
    "properties.before.properties.webmcp.anyOf.0",
    orRetained(passive.before.shape.webmcp.unwrap().unwrap().description),
  );
  expect(advertised).toHaveProperty(
    "properties.before_scenario",
    orRetained(scenario.before_scenario.description),
  );
  // Analyst-authored controls stay explicit.
  expect(advertised).toHaveProperty(
    "properties.normalization.properties.rules.items.required",
    ["rule_id", "artifacts", "match", "replacement"],
  );
  const validate = new Ajv2020({ strict: false }).compile(advertised);
  expect(validate({ before_scenario: {}, after_scenario: {} })).toBe(true);
  expect(validate({ before_scenario: "{}", after_scenario: {} })).toBe(false);

  // Every other projection of the same schemas stays canonical: the plain
  // conversion behind `--schema`, and the producer's own output schema.
  const plain = JSON.stringify(
    z.toJSONSchema(comparison.inputSchema, { io: "input" }),
  );
  expect(plain).not.toContain(COMPLETE_OBSERVATION_GUIDANCE);
  expect(plain).not.toContain("x-rea-");
  // The full scenario capture declaration, including its step list.
  expect(plain).toContain('"steps":{');
  expect(
    JSON.stringify(
      toolOutputSchemaWithMetadata(browserContract("inspect_web_page"))[
        "~standard"
      ].jsonSchema.output({ target: "draft-2020-12" }),
    ),
  ).not.toContain(COMPLETE_OBSERVATION_GUIDANCE);
});

const referenceWideningCases: readonly {
  name: string;
  schema: Record<string, unknown>;
  input: unknown;
  unchanged?: boolean;
}[] = [
  {
    name: "oneOf",
    schema: {
      definitions: { off: { type: "string", pattern: "^😀$" } },
      properties: { value: { oneOf: [{ $ref: "#/definitions/off" }, {}] } },
    },
    input: { value: "x" },
  },
  {
    name: "not",
    schema: {
      definitions: { off: { type: "string", pattern: "^😀$" } },
      properties: { value: { not: { $ref: "#/definitions/off" } } },
    },
    input: { value: "x" },
  },
  {
    name: "if",
    schema: {
      definitions: { off: { type: "string", pattern: "^😀$" } },
      properties: {
        value: { if: { $ref: "#/definitions/off" }, then: false, else: true },
      },
    },
    input: { value: "x" },
  },
  {
    name: "chain",
    schema: {
      definitions: {
        off: { type: "string", pattern: "^😀$" },
        alias: { $ref: "#/definitions/off" },
      },
      properties: { value: { not: { $ref: "#/definitions/alias" } } },
    },
    input: { value: "x" },
  },
  {
    name: "recursive affected",
    schema: {
      definitions: {
        node: {
          type: "object",
          properties: {
            flag: { type: "string", pattern: "^😀$" },
            next: { $ref: "#/definitions/node" },
          },
          required: ["flag"],
        },
      },
      properties: { value: { not: { $ref: "#/definitions/node" } } },
    },
    input: { value: { flag: "x" } },
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
      definitions: { flag: { type: "string", pattern: "^😀$" } },
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
    const advertised = presentOutputJsonSchema(canonical);
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
    // An affected site is rewritten; an unaffected one is left as it was.
    if (unchanged)
      expect(advertised.properties, name).toEqual(canonical.properties);
    else expect(advertised.properties, name).not.toEqual(canonical.properties);
  },
);

it("keeps an upper contains bound from rejecting canonical items after referenced pattern widening", () => {
  const canonical = {
    type: "object",
    definitions: { off: { type: "string", pattern: "^😀$" } },
    properties: {
      values: {
        type: "array",
        contains: { $ref: "#/definitions/off" },
        minContains: 0,
        maxContains: 1,
      },
    },
  };
  const advertised = presentOutputJsonSchema(canonical);
  const input = { values: ["x", "y"] };
  expect(new Ajv2020({ strict: false }).compile(canonical)(input)).toBe(true);
  expect(new Ajv2020({ strict: false }).compile(advertised)(input)).toBe(true);
  expect(advertised).not.toHaveProperty("properties.values.maxContains");
});

it.each([false, true])(
  "preserves conditional evaluation annotations (referenced: %s)",
  (referenced) => {
    const conditional = {
      if: { properties: { flag: { type: "string", pattern: "^😀$" } } },
      then: { properties: { extra: { type: "string" } } },
    };
    const canonical = {
      type: "object",
      definitions: { conditional },
      ...(referenced ? { $ref: "#/definitions/conditional" } : conditional),
      unevaluatedProperties: false,
    };
    const advertised = presentOutputJsonSchema(canonical);
    const input = { flag: "😀", extra: "kept" };
    expect(new Ajv2020({ strict: false }).compile(canonical)(input)).toBe(true);
    expect(new Ajv2020({ strict: false }).compile(advertised)(input)).toBe(
      true,
    );
    // The widened condition goes, and with it the evaluation it provided.
    expect(advertised).not.toHaveProperty("unevaluatedProperties");
  },
);

it("retains item annotations when only the unsafe contains maximum leaves", () => {
  const canonical = {
    type: "object",
    properties: {
      values: {
        type: "array",
        // No portable regex form exists, so the advertisement omits it.
        contains: { type: "string", pattern: "^😀$" },
        maxContains: 1,
        unevaluatedItems: false,
      },
    },
  };
  const advertised = presentOutputJsonSchema(canonical);
  const input = { values: ["😀"] };
  expect(new Ajv2020({ strict: false }).compile(canonical)(input)).toBe(true);
  expect(new Ajv2020({ strict: false }).compile(advertised)(input)).toBe(true);
  expect(advertised).toHaveProperty("properties.values.contains", {
    type: "string",
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
        if: { type: "string", pattern: "^😀$" },
        then: { type: "string" },
        else: { type: "boolean" },
      },
    },
    unevaluatedProperties: false,
  };
  const advertised = presentOutputJsonSchema(canonical);
  const validate = new Ajv2020({ strict: false }).compile(advertised);
  expect(validate({ child: true })).toBe(true);
  expect(validate({ child: true, unknown: "reject" })).toBe(false);
  expect(advertised.unevaluatedProperties).toBe(false);
  expect(advertised).not.toHaveProperty("properties.child.if");
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
        alias: { $ref: "#/definitions/number", pattern: "^😀$" },
      },
      properties: { value: { not: { $ref: "#/definitions/alias" } } },
    };
    const advertised = presentOutputJsonSchema(canonical);
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
      // No portable regex form exists, so the advertisement omits it.
      definitions: { off: { type: "string", pattern: "^😀$" } },
      default: literal,
      properties: {
        value: { $ref: "#/default/conditional" },
        stable: { $ref: "#/default/unaffected" },
      },
      unevaluatedProperties: false,
    };
    const advertised = presentOutputJsonSchema(canonical);
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
        not: {
          type: "number",
          definitions: { unused: { type: "string", pattern: "^😀$" } },
        },
      },
    },
  };
  const advertised = presentOutputJsonSchema(canonical);
  expect(advertised).toHaveProperty("properties.value.not.type", "number");
  const validate = new Ajv2020({ strict: false }).compile(advertised);
  expect(validate({ value: "kept" })).toBe(true);
  expect(validate({ value: 1 })).toBe(false);
});
