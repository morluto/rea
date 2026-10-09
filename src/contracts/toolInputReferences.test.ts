import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { presentInputJsonSchema } from "./inputSchemaPresentation.js";
import { toolContract } from "./toolContracts.js";
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
      ]) {
        const sample = {
          breakpoints: [
            {
              kind: "objc-method",
              class_name: "NSURLSession",
              selector,
            },
          ],
        };
        expect(validate(sample)).toBe(
          contract.inputSchema.safeParse(sample).success,
        );
      }
      const unexpected = {
        breakpoints: [
          {
            kind: "objc-method",
            class_name: "NSURLSession",
            selector: "setFoo:",
            unexpected: true,
          },
        ],
      };
      expect(contract.inputSchema.safeParse(unexpected).success).toBe(false);
      expect(validate(unexpected)).toBe(false);
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
      const inline = toolInputSchemaWithMetadata({
        ...toolContract("open_binary"),
        inputSchema: canonical,
      })["~standard"].jsonSchema.input({
        target,
        libraryOptions: { reused: "inline" },
      });
      expect(inline).toMatchObject({
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
    const branches = z
      .array(z.record(z.string(), z.unknown()))
      .parse(presented.anyOf);
    expect(branches).toHaveLength(2);
    for (const presentedBranch of branches) {
      expect(presentedBranch).toMatchObject(branch);
      const properties = presentedBranch.properties;
      if (typeof properties !== "object" || properties === null)
        throw new Error("Missing branch properties");
      expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
      expect(Object.hasOwn(properties, "__proto__")).toBe(true);
    }
  });

  it("preserves root alternatives, required pairs, and mixed-family exclusions", () => {
    const schema = z.union([
      z.strictObject({ before: z.string(), after: z.string() }),
      z.strictObject({
        before_scenario: z.number(),
        after_scenario: z.number(),
      }),
    ]);
    const canonical = z.toJSONSchema(schema, { io: "input" });
    const advertised = presentInputJsonSchema(
      canonical,
      (property) => property,
    );
    const validate = new Ajv2020({ strict: false }).compile(advertised);
    for (const input of [
      {},
      { before: "first" },
      { before: "first", after: "second" },
      { before_scenario: 1, after_scenario: 2 },
      { before: "first", after_scenario: 2 },
      {
        before: "first",
        after: "second",
        before_scenario: 1,
        after_scenario: 2,
      },
      { before_scenario: 1, after_scenario: "wrong" },
    ])
      expect(validate(input)).toBe(schema.safeParse(input).success);
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
