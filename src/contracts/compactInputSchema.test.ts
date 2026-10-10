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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const collectReferences = (
  node: unknown,
  found: readonly string[] = [],
): readonly string[] => {
  if (Array.isArray(node))
    return node.flatMap((child) => collectReferences(child, found));
  if (!isRecord(node)) return found;
  const extended =
    typeof node.$ref === "string" ? [...found, node.$ref] : found;
  return Object.values(node).flatMap((child) =>
    collectReferences(child, extended),
  );
};

const resolveReference = (
  root: Record<string, unknown>,
  reference: string,
): unknown => {
  if (!reference.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const token of reference.slice(2).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
};

describe("compact advertised input schema", () => {
  it("drops nested annotation prose while keeping validation keywords", () => {
    const { schema, presentation } = compactAdvertisedInputSchema(
      structuredClone(annotatedSchema),
      13 * 1024,
    );
    expect(presentation).toBe("shared");
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

  it("shares repeated annotation-free subschemas through schema-local references", () => {
    const { schema } = compactAdvertisedInputSchema(
      {
        type: "object",
        properties: {
          before: structuredClone(repeatedObservation),
          after: structuredClone(repeatedObservation),
        },
        required: ["before", "after"],
        additionalProperties: false,
      },
      13 * 1024,
    );
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.before).toEqual({ $ref: "#/$defs/shared0" });
    expect(properties.after).toEqual({ $ref: "#/$defs/shared0" });
    const definitions = schema.$defs as Record<string, unknown>;
    expect(definitions.shared0).toEqual(repeatedObservation);
    expect(serializedBytes(schema)).toBeLessThan(
      serializedBytes({ ...repeatedObservation, second: repeatedObservation }),
    );
    for (const reference of collectReferences(schema))
      expect(resolveReference(schema, reference)).toBeDefined();
  });

  it("reuses an existing equivalent definition instead of adding one", () => {
    const { schema } = compactAdvertisedInputSchema(
      {
        type: "object",
        $defs: { observation: structuredClone(repeatedObservation) },
        properties: {
          before: { $ref: "#/$defs/observation" },
          after: structuredClone(repeatedObservation),
        },
      },
      13 * 1024,
    );
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.before).toEqual({ $ref: "#/$defs/observation" });
    expect(properties.after).toEqual({ $ref: "#/$defs/observation" });
    const definitions = schema.$defs as Record<string, unknown>;
    expect(Object.keys(definitions)).toEqual(["observation"]);
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

  it("keeps shared presentations under the measured provider budget", () => {
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
    expect(presentation).toBe("shared");
    expect(serializedBytes(schema)).toBeLessThanOrEqual(13312);
    for (const reference of collectReferences(schema))
      expect(resolveReference(schema, reference)).toBeDefined();
  });
});
