import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { inlineLocalJsonSchemaReferences } from "../../tests/fixtures/localJsonSchemaReferences.js";
import { presentInputJsonSchema } from "./inputSchemaPresentation.js";
import { TOOL_CONTRACTS, toolContract } from "./toolContracts.js";
import { toolInputSchemaWithMetadata } from "./toolSchemaMetadata.js";

describe("advertised input references", () => {
  it.each(["draft-2020-12", "draft-07"] as const)(
    "preserves production native-selector constraints in %s",
    (target) => {
      const contract = toolContract("observe_native_calls");
      const advertised = toolInputSchemaWithMetadata(contract)[
        "~standard"
      ].jsonSchema.input({ target });
      const ajv =
        target === "draft-2020-12"
          ? new Ajv2020({ strict: false })
          : new Ajv({ strict: false });
      const validate = ajv.compile(advertised);
      for (const selector of [
        "setFoo:",
        "dataTaskWithRequest:completionHandler:",
        "",
        "bad selector:",
        "bad[selector]:",
        "set\0Foo:",
        "setFoo:\n",
      ])
        for (const extra of [{}, { unexpected: true }]) {
          const sample = {
            breakpoints: [
              {
                kind: "objc-method",
                class_name: "NSURLSession",
                selector,
                ...extra,
              },
            ],
          };
          expect(validate(sample)).toBe(
            contract.inputSchema.safeParse(sample).success,
          );
        }
    },
  );

  it.each(["draft-2020-12", "draft-07"] as const)(
    "preserves complete input meaning and examples through %s references",
    (target) => {
      for (const contract of TOOL_CONTRACTS) {
        const projection =
          toolInputSchemaWithMetadata(contract)["~standard"].jsonSchema.input;
        const referenced = projection({ target });
        const inline = projection({
          target,
          libraryOptions: { reused: "inline" },
        });
        expect(referenced.type, contract.name).toBe("object");
        expect(
          inlineLocalJsonSchemaReferences(referenced),
          contract.name,
        ).toEqual(inlineLocalJsonSchemaReferences(inline));
        expect(referenced.examples, contract.name).toEqual(
          contract.examples.map(({ input }) => input),
        );
        expect(projection({ target })).toBe(referenced);
      }
    },
  );

  it.each(["draft-2020-12", "draft-07"] as const)(
    "retains specialized descriptions, literal metadata and strict validation in %s",
    (target) => {
      const literal = {
        properties: { target: { $ref: "literal caller data" } },
        examples: [{ properties: { path: {} } }],
      };
      const range = z
        .object({
          offset: z.number().int().nonnegative().max(65535),
          length: z.number().int().min(1),
        })
        .strict()
        .describe("Exact byte range in the selected artifact.");
      const canonical = z
        .object({
          before: range,
          after: range,
          metadata: z
            .record(z.string(), z.unknown())
            .meta({ default: literal, examples: [literal] }),
          constructor: z.string(),
        })
        .strict();
      const advertised = toolInputSchemaWithMetadata({
        ...toolContract("open_binary"),
        inputSchema: canonical,
      })["~standard"].jsonSchema.input({ target });
      expect(inlineLocalJsonSchemaReferences(advertised)).toMatchObject({
        properties: {
          before: { description: "Exact byte range in the selected artifact." },
          after: { description: "Exact byte range in the selected artifact." },
          metadata: { default: literal, examples: [literal] },
          constructor: { description: "Value for constructor." },
        },
      });
      const ajv =
        target === "draft-2020-12"
          ? new Ajv2020({ strict: false })
          : new Ajv({ strict: false });
      const validate = ajv.compile(advertised);
      const valid = {
        before: { offset: 0, length: 1 },
        after: { offset: 65535, length: 2 },
        metadata: literal,
        constructor: "constructor data",
      };
      const samples = [
        valid,
        ...[
          { offset: -1 },
          { offset: 65536 },
          { offset: 0.5 },
          { length: 0 },
          { unexpected: true },
        ].map((change) => ({
          ...valid,
          before: { ...valid.before, ...change },
        })),
        { ...valid, after: null },
        { ...valid, unexpected: true },
      ];
      expect(canonical.safeParse(valid).success).toBe(true);
      for (const sample of samples)
        expect(validate(sample)).toBe(canonical.safeParse(sample).success);
    },
  );
});

describe("root input presentation", () => {
  it("normalizes repeated string intersections without widening validation", () => {
    const root = {
      type: "string",
      minLength: 1,
      description: "Exact selector.",
      allOf: [
        { type: "string", pattern: "^[^\\s]+$" },
        { allOf: [{ type: "string", pattern: "^[^\\s]+$" }], minLength: 2 },
      ],
    };
    const normalized = inlineLocalJsonSchemaReferences(root);
    expect(normalized).toEqual({
      type: "string",
      minLength: 2,
      pattern: "^[^\\s]+$",
      description: "Exact selector.",
    });
    const ajv = new Ajv2020({ strict: false });
    const original = ajv.compile(root);
    const projected = ajv.compile(
      z.record(z.string(), z.unknown()).parse(normalized),
    );
    for (const sample of ["", "a", "aa", "a a", "a\n", null, {}])
      expect(projected(sample)).toBe(original(sample));
  });

  it("preserves prototype-named properties in object-root presentation", () => {
    const fields = Object.fromEntries([
      ["__proto__", { type: "string" }],
      ["constructor", { type: "number" }],
    ]);
    const branch = {
      type: "object",
      properties: fields,
      required: ["__proto__"],
      additionalProperties: false,
    };
    const presented = presentInputJsonSchema(
      { anyOf: [branch, branch] },
      (property) => `Parameter ${property}`,
    );
    expect(presented).toMatchObject({
      type: "object",
      required: ["__proto__"],
      minProperties: 1,
      additionalProperties: false,
      properties: fields,
    });
    expect(presented.anyOf).toBeUndefined();
    expect(Object.getPrototypeOf(presented.properties)).toBe(Object.prototype);
    expect(Object.hasOwn(presented.properties ?? {}, "__proto__")).toBe(true);
  });

  it("retains reference siblings and does not manufacture root branch constraints", () => {
    const branch = { $ref: "#/$defs/object", additionalProperties: false };
    const root = {
      $defs: {
        object: { type: "object", properties: { value: { type: "string" } } },
      },
      anyOf: [branch],
    };
    const presented = presentInputJsonSchema(root, (property) => property);
    expect(presented.anyOf).toEqual([branch]);
    const ajv = new Ajv2020({ strict: false });
    for (const sample of [{}, { value: "value" }, null])
      expect(ajv.compile(presented)(sample)).toBe(ajv.compile(root)(sample));
  });

  it("preserves specialized guidance across reference chains without following literal references", () => {
    const literal = { properties: { literal: {} }, $ref: "#/$defs/missing" };
    const presented = presentInputJsonSchema(
      {
        $defs: {
          "a~b": {
            type: "string",
            description: "Literal URL selected by the caller.",
          },
          alias: { $ref: "#/$defs/a~0b" },
        },
        type: "object",
        properties: {
          url: { $ref: "#/$defs/alias" },
          other: { $ref: "#/$defs/alias", description: "Explicit override." },
        },
        default: literal,
        const: literal,
        examples: [literal],
        enum: [literal],
      },
      (property) => `Parameter ${property}`,
    );
    expect(presented).toMatchObject({
      properties: {
        url: { description: "Literal URL selected by the caller." },
        other: { description: "Explicit override." },
      },
      default: literal,
      const: literal,
      examples: [literal],
      enum: [literal],
    });
  });
});
