import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { compactAdvertisedInputSchema } from "./compactInputSchema.js";

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const repeatedObservation = {
  type: "object",
  properties: {
    captured_url: { type: "string", minLength: 1 },
    captured_at: { type: "string", minLength: 1 },
    status_code: { type: "integer", minimum: 100, maximum: 599 },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
      minProperties: 1,
    },
    body_digest: { type: "string", minLength: 64, maxLength: 64 },
  },
  required: ["captured_url", "captured_at", "status_code"],
  additionalProperties: false,
} as const;

const annotatedSchema = {
  type: "object",
  description: "Root group guidance stays.",
  properties: {
    query: {
      type: "string",
      description: "Field guidance leaves.",
      examples: ["seed"],
      default: "seed",
      title: "Query",
      minLength: 1,
    },
    limits: {
      type: "object",
      description: "Nested guidance leaves.",
      properties: {
        max_results: {
          type: "integer",
          description: "Leaves.",
          minimum: 1,
          maximum: 500,
          default: 50,
        },
      },
      required: ["max_results"],
      additionalProperties: false,
    },
  },
  required: ["query"],
  dependentRequired: { limits: ["query"] },
  additionalProperties: false,
} as const;

const oversizedPairSchema = (): Record<string, unknown> => {
  const deepStructure = {
    type: "object",
    description: "Nested guidance that leaves.",
    properties: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `field_${index}`,
        { type: "string", minLength: 1, description: `Field ${index}` },
      ]),
    ),
    required: Array.from({ length: 40 }, (_, index) => `field_${index}`),
    additionalProperties: false,
  };
  return {
    type: "object",
    description: "Provide a complete capture pair.",
    properties: {
      before: structuredClone(deepStructure),
      after: structuredClone(deepStructure),
    },
    required: ["before", "after"],
    additionalProperties: false,
  };
};

describe("compact advertised input schema", () => {
  it("drops nested annotation prose while keeping validation keywords", () => {
    const { schema, presentation } = compactAdvertisedInputSchema(
      structuredClone(annotatedSchema),
      13 * 1024,
    );
    expect(presentation).toBe("inline");
    expect(schema.description).toBe("Root group guidance stays.");
    const query = (schema.properties as Record<string, unknown>)
      .query as Record<string, unknown>;
    expect(query).toEqual({ type: "string", minLength: 1 });
    const limits = (schema.properties as Record<string, unknown>)
      .limits as Record<string, unknown>;
    expect(limits.description).toBeUndefined();
    expect(limits.required).toEqual(["max_results"]);
    expect(schema.dependentRequired).toEqual({ limits: ["query"] });
    expect(schema.required).toEqual(["query"]);
  });

  it("keeps annotation-shaped keys inside literal const and enum data", () => {
    const literalMode = {
      description: "saved data",
      default: { keep: "me" },
    };
    const { schema } = compactAdvertisedInputSchema(
      {
        type: "object",
        properties: {
          mode: { enum: [literalMode] },
          pinned: { const: { description: "literal" } },
        },
      },
      13 * 1024,
    );
    const properties = schema.properties as Record<string, unknown>;
    expect((properties.mode as Record<string, unknown>).enum).toEqual([
      literalMode,
    ]);
    expect((properties.pinned as Record<string, unknown>).const).toEqual({
      description: "literal",
    });
  });

  it("inlines local references without changing validation or literal data", () => {
    const original = {
      type: "object",
      $defs: { "observation/~": structuredClone(repeatedObservation) },
      properties: {
        before: { $ref: "#/$defs/observation~1~0" },
        after: { $ref: "#/$defs/observation~1~0" },
        literal: { const: { $ref: "saved data", $defs: { keep: true } } },
      },
      required: ["before", "after"],
      additionalProperties: false,
    };
    const { schema, presentation } = compactAdvertisedInputSchema(
      original,
      13312,
    );
    expect(presentation).toBe("inline");
    expect(schema.$defs).toBeUndefined();
    const ajv = new Ajv2020({ strict: false });
    const canonical = ajv.compile(original);
    const compact = ajv.compile(schema);
    const observation = {
      captured_url: "https://example.com",
      captured_at: "now",
      status_code: 200,
    };
    for (const input of [
      { before: observation, after: observation },
      { before: observation, after: { ...observation, status_code: 99 } },
      {
        before: observation,
        after: observation,
        literal: original.properties.literal.const,
      },
    ])
      expect(compact(input)).toBe(canonical(input));
  });

  it("keeps unconstrained JSON values explicit for client type inference", () => {
    const { schema } = compactAdvertisedInputSchema(
      {
        type: "object",
        properties: { normalized_result: {}, literal: { const: {} } },
      },
      13312,
    );
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.normalized_result).toEqual({
      type: ["null", "boolean", "object", "array", "number", "string"],
    });
    expect(properties.literal).toEqual({ const: {} });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    for (const normalized_result of [null, true, {}, [], 42, "result"])
      expect(validate({ normalized_result })).toBe(true);
  });

  it("preserves independent validation constraints on reference siblings", () => {
    const original = {
      type: "object",
      $defs: { text: { type: "string", minLength: 3 } },
      properties: {
        query: { $ref: "#/$defs/text", minLength: 1, maxLength: 5 },
      },
    };
    const { schema } = compactAdvertisedInputSchema(original, 13312);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate({ query: "a" })).toBe(false);
    expect(validate({ query: "abc" })).toBe(true);
    expect(validate({ query: "abcdef" })).toBe(false);
  });
});

describe("compact input schema budget and reduction", () => {
  it("budgets repeated-reference expansion before materializing it", () => {
    const definitions: Record<string, unknown> = {
      leaf: structuredClone(repeatedObservation),
    };
    for (let index = 0; index < 30; index++) {
      const $ref = `#/$defs/${index === 0 ? "leaf" : `level${index - 1}`}`;
      definitions[`level${index}`] = {
        type: "object",
        properties: { left: { $ref }, right: { $ref } },
      };
    }
    const { schema, presentation } = compactAdvertisedInputSchema(
      {
        type: "object",
        $defs: definitions,
        properties: { tree: { $ref: "#/$defs/level29" } },
      },
      1024,
    );
    expect(presentation).toBe("reduced");
    expect(serializedBytes(schema)).toBeLessThanOrEqual(1024);
    expect(schema.properties).toEqual({ tree: { type: "object" } });
  });

  it("retains referenced object, array and nullable types in reduced inputs", () => {
    const original = {
      type: "object",
      $defs: {
        pair: oversizedPairSchema(),
        observations: {
          type: "array",
          items: structuredClone(repeatedObservation),
        },
        nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      properties: {
        capture: { $ref: "#/$defs/pair", description: "Complete capture." },
        observations: { $ref: "#/$defs/observations" },
        label: { $ref: "#/$defs/nullable" },
      },
    };
    const { schema, presentation } = compactAdvertisedInputSchema(
      original,
      1024,
    );
    expect(presentation).toBe("reduced");
    expect(schema.properties).toEqual({
      capture: { type: "object", description: "Complete capture." },
      observations: { type: "array" },
      label: { type: ["string", "null"] },
    });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate({ capture: {}, observations: [], label: null })).toBe(true);
    expect(validate({ capture: {}, observations: [], label: "capture" })).toBe(
      true,
    );
    expect(validate({ capture: "{}", observations: [], label: null })).toBe(
      false,
    );
  });

  it("reduces structurally oversized schemas to the shallow property presentation", () => {
    const compacted = compactAdvertisedInputSchema(oversizedPairSchema(), 1024);
    expect(compacted.presentation).toBe("reduced");
    expect(serializedBytes(compacted.schema)).toBeLessThanOrEqual(1024);
    expect(compacted.schema.type).toBe("object");
    expect(compacted.schema.description).toContain(
      "Provide a complete capture pair.",
    );
    expect(compacted.schema.description).toContain(
      "compact input schema profile",
    );
    const properties = compacted.schema.properties as Record<string, unknown>;
    expect(properties.before).toEqual({
      type: "object",
      description: "Nested guidance that leaves.",
    });
    expect(properties.after).toEqual(properties.before);
    expect(compacted.schema.required).toEqual(["before", "after"]);
  });

  it("produces deterministic output for equal input", () => {
    const schema = {
      type: "object",
      properties: {
        before: structuredClone(repeatedObservation),
        after: structuredClone(repeatedObservation),
      },
    };
    expect(compactAdvertisedInputSchema(schema, 13 * 1024)).toEqual(
      compactAdvertisedInputSchema(structuredClone(schema), 13 * 1024),
    );
  });

  it("keeps inline presentations under the measured provider budget", () => {
    const { schema, presentation } = compactAdvertisedInputSchema(
      {
        type: "object",
        description: "Group guidance.",
        properties: {
          before: structuredClone(repeatedObservation),
          after: structuredClone(repeatedObservation),
          normalization: {
            type: "object",
            description: "Rules.",
            properties: { rules: { type: "array", items: { type: "string" } } },
          },
        },
      },
      13312,
    );
    expect(presentation).toBe("inline");
    expect(serializedBytes(schema)).toBeLessThanOrEqual(13312);
  });
});
