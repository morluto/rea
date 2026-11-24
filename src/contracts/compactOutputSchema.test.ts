import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { schemaDepth } from "./compactJsonSchema.js";
import {
  compactAdvertisedOutputSchema,
  listedOutputJsonSchema,
  presentAdvertisedOutputSchema,
} from "./compactOutputSchema.js";
import { COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES } from "./mcpSchemaPresentation.js";
import { advertisedOutputJsonSchema } from "./toolSchemaMetadata.js";
import { toolContract } from "./toolContracts.js";

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const annotatedSchema = {
  type: "object",
  description: "Root result guidance stays.",
  properties: {
    value: {
      type: "string",
      description: "Field guidance leaves.",
      examples: ["seed"],
      default: "seed",
      title: "Value",
    },
    nested: {
      type: "object",
      description: "Nested guidance leaves.",
      properties: {
        count: { type: "integer", description: "Leaves.", minimum: 1 },
      },
      required: ["count"],
      additionalProperties: false,
    },
  },
  required: ["value", "nested"],
  additionalProperties: false,
} as const;

const referencedSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:rea:tool-output:sha256:fixture",
  type: "object",
  properties: {
    entries: { type: "array", items: { $ref: "#/$defs/entry" } },
  },
  required: ["entries"],
  $defs: {
    entry: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
} as const;

describe("compact advertised output schema", () => {
  it("keeps nullable integers valid when a deep sibling triggers pruning", () => {
    const nest = (
      leaf: Record<string, unknown>,
      levels: number,
    ): Record<string, unknown> =>
      levels === 0
        ? leaf
        : { type: "object", properties: { child: nest(leaf, levels - 1) } };
    const { schema, presentation } = compactAdvertisedOutputSchema(
      {
        type: "object",
        properties: {
          count: { type: ["integer", "null"] },
          deep: nest({ type: "string" }, 9),
        },
        required: ["count", "deep"],
      },
      100_000,
    );
    expect(presentation).toBe("inline");
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate({ count: 5, deep: {} })).toBe(true);
    expect(validate({ count: null, deep: {} })).toBe(true);
    expect(serializedBytes(schema)).toBeLessThanOrEqual(100_000);
  });

  it("keeps untyped deep schemas accepting every value after pruning", () => {
    const nest = (
      leaf: Record<string, unknown>,
      levels: number,
    ): Record<string, unknown> =>
      levels === 0 ? leaf : { properties: { child: nest(leaf, levels - 1) } };
    const { schema, presentation } = compactAdvertisedOutputSchema(
      {
        type: "object",
        properties: { deep: nest({ type: "string" }, 9) },
        required: ["deep"],
      },
      100_000,
    );
    // Nine untyped property nestings put the replaced node at depth 8.
    // Pruning leaves that node as an empty schema.
    expect(schema).toEqual({
      type: "object",
      properties: {
        deep: {
          properties: {
            child: {
              properties: {
                child: {
                  properties: {
                    child: {},
                  },
                },
              },
            },
          },
        },
      },
      required: ["deep"],
    });
    expect(schemaDepth(schema)).toBe(8);
    expect(presentation).toBe("inline");
    const validate = new Ajv2020({ strict: false }).compile(schema);
    for (const child of [null, 1, "text", { nested: true }])
      expect(validate({ deep: { child: { child: { child } } } })).toBe(true);
  });

  it("drops nested annotation prose while keeping the root guidance and validation", () => {
    const { schema, presentation } = compactAdvertisedOutputSchema(
      structuredClone(annotatedSchema),
      4 * 1024,
    );
    expect(presentation).toBe("inline");
    expect(schema.description).toBe("Root result guidance stays.");
    const value = (schema.properties as Record<string, unknown>)
      .value as Record<string, unknown>;
    expect(value).toEqual({ type: "string" });
    const nested = (schema.properties as Record<string, unknown>)
      .nested as Record<string, unknown>;
    expect(nested.description).toBeUndefined();
    expect(nested.required).toEqual(["count"]);
    expect(schema.required).toEqual(["value", "nested"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("inlines local definitions and drops the content-bound identity", () => {
    const { schema, presentation } = compactAdvertisedOutputSchema(
      structuredClone(referencedSchema),
      4 * 1024,
    );
    expect(presentation).toBe("inline");
    expect(schema.$defs).toBeUndefined();
    expect(schema.$id).toBeUndefined();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const entries = (schema.properties as Record<string, unknown>)
      .entries as Record<string, unknown>;
    expect(entries.items).toMatchObject({ type: "object" });
  });

  it("keeps a non-object root accepting every JSON value when it cannot fit", () => {
    const arraySchema = {
      type: "array",
      items: Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `field_${index}`,
          { type: "string", description: `Field ${index}` },
        ]),
      ),
    };
    const { schema, presentation } = compactAdvertisedOutputSchema(
      arraySchema,
      128,
    );
    expect(presentation).toBe("reduced");
    expect(serializedBytes(schema)).toBeLessThanOrEqual(128);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(["anything"])).toBe(true);
    expect(validate({ also: "anything" })).toBe(true);
  });
});

describe("listed output schema", () => {
  it("stamps type object on a typeless object-shaped union before compaction", () => {
    const union = {
      oneOf: [
        {
          type: "object",
          properties: { status: { const: "matches" } },
          required: ["status"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { status: { const: "empty" } },
          required: ["status"],
          additionalProperties: false,
        },
      ],
    };
    const listed = listedOutputJsonSchema(union);
    expect(listed).toEqual({ type: "object", ...union });
    expect(listedOutputJsonSchema(listed)).toBe(listed);
    expect(
      listedOutputJsonSchema({ type: "array", items: { type: "string" } }),
    ).toEqual({ type: "array", items: { type: "string" } });

    const branch = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `field_${index}`,
          { type: "string", description: `field ${index} `.repeat(30) },
        ]),
      ),
      additionalProperties: false,
    };
    const wide = { oneOf: [branch, branch] };
    const compacted = presentAdvertisedOutputSchema(
      listedOutputJsonSchema(wide),
      { budgetBytes: 256 },
    );
    const unstamped = presentAdvertisedOutputSchema(wide, { budgetBytes: 256 });
    expect(compacted.type).toBe("object");
    expect(unstamped).toEqual({
      type: ["null", "boolean", "object", "array", "number", "string"],
      items: {},
    });
  });

  it("stamps a typeless $ref union of objects the way SDK 2.4.0 lists it", () => {
    const schema = {
      oneOf: [{ $ref: "#/$defs/matches" }, { $ref: "#/$defs/empty" }],
      $defs: {
        matches: {
          type: "object",
          properties: { status: { const: "matches" } },
        },
        empty: { type: "object", properties: { status: { const: "empty" } } },
      },
    };
    expect(listedOutputJsonSchema(schema)).toEqual({
      type: "object",
      ...schema,
    });
    expect(
      listedOutputJsonSchema({
        oneOf: [{ $ref: "#/$defs/value" }],
        $defs: { value: { type: "string" } },
      }),
    ).toEqual({
      oneOf: [{ $ref: "#/$defs/value" }],
      $defs: { value: { type: "string" } },
    });
  });
});

describe("compact object-union output schemas", () => {
  it("keeps an object-stamped union's alternatives when the canonical schema cannot inline", () => {
    // SDK 2.4.0 stamps type:object on a root that is only a $ref union of
    // objects. search_guidance is that shape and does not fit the compact
    // budget once its definitions are expanded.
    const canonical = advertisedOutputJsonSchema(
      toolContract("search_guidance"),
    );
    expect(canonical.type).toBeUndefined();
    expect(Array.isArray(canonical.oneOf)).toBe(true);
    const { schema, presentation } = compactAdvertisedOutputSchema(
      { type: "object", ...canonical },
      COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES,
    );
    expect(presentation).toBe("reduced");
    expect(schema.properties).toBeUndefined();
    expect(schema.type).toBe("object");
    const alternatives = schema.anyOf as Record<string, unknown>[];
    expect(alternatives.length).toBeGreaterThan(1);
    expect(
      alternatives.every(
        (branch) =>
          branch.type === "object" &&
          typeof (branch.properties as Record<string, unknown> | undefined)
            ?.status === "object",
      ),
    ).toBe(true);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const unavailable = {
      status: "bundle_unavailable",
      source: "installed_rea_guidance",
      content_kind: "documentation",
      message: "The guidance bundle is not installed.",
    };
    const stale = {
      status: "stale_continuation",
      source: "installed_rea_guidance",
      content_kind: "documentation",
      message: "The continuation no longer matches this bundle.",
    };
    expect(validate(unavailable)).toBe(true);
    expect(validate(stale)).toBe(true);
    expect(validate([])).toBe(false);
    expect(serializedBytes(schema)).toBeLessThanOrEqual(
      COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES,
    );
  });

  it("keeps an already object-typed workflow union's alternatives", () => {
    // guided_workflows declares an object root so older codecs do not wrap
    // the result. That declaration has no root properties; the compact form
    // still has to describe each action.
    const { schema, presentation } = compactAdvertisedOutputSchema(
      advertisedOutputJsonSchema(toolContract("guided_workflows")),
      COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES,
    );
    expect(presentation).toBe("reduced");
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeUndefined();
    const alternatives = schema.anyOf as Record<string, unknown>[];
    expect(alternatives).toHaveLength(2);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(
      validate({
        action: "list",
        workflows: [
          {
            workflow_id: "inspect",
            description: "Inspect one artifact.",
            arguments: [],
          },
        ],
      }),
    ).toBe(true);
    expect(
      validate({
        action: "render",
        workflow_id: "inspect",
        rendered_prompt: "Inspect the artifact.",
      }),
    ).toBe(true);
    expect(validate([])).toBe(false);
    expect(serializedBytes(schema)).toBeLessThanOrEqual(
      COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES,
    );
  });

  it("keeps a fitting object-stamped union inline, including the object type", () => {
    const canonical = advertisedOutputJsonSchema(
      toolContract("read_guidance_section"),
    );
    const { schema, presentation } = compactAdvertisedOutputSchema(
      { type: "object", ...canonical },
      COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES,
    );
    expect(presentation).toBe("inline");
    expect(schema.type).toBe("object");
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect(schema.$id).toBeUndefined();
  });
});
