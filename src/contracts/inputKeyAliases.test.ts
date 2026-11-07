import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonicalInputKeys,
  compatibleToolInputSchema,
  inputKeyAliasesFor,
} from "./inputKeyAliases.js";

const procedureInput = z.strictObject({
  procedure: z.string(),
  document: z.string().optional(),
});
const searchInput = z.strictObject({
  pattern: z.string().min(1),
  mode: z.enum(["literal", "regex"]).default("literal"),
});

describe("named compatible input contracts", () => {
  it("uses compatibility spellings only when they do not collide with existing keys", () => {
    expect(inputKeyAliasesFor(procedureInput)).toEqual({
      address: "procedure",
    });
    expect(inputKeyAliasesFor(searchInput)).toEqual({ query: "pattern" });
    expect(
      inputKeyAliasesFor(
        z.strictObject({ procedure: z.string(), address: z.string() }),
      ),
    ).toEqual({});
  });
  it("preserves caller values and normalizes one parsed representation", () => {
    const caller = {
      address: "0x401000",
      document: "Caller & exact % document",
    };
    expect(canonicalInputKeys(caller, { address: "procedure" })).toEqual({
      procedure: caller.address,
      document: caller.document,
    });
    expect(caller).toEqual({
      address: "0x401000",
      document: "Caller & exact % document",
    });
  });
  it("advertises and parses both accepted spellings while rejecting ambiguity", () => {
    const schema = compatibleToolInputSchema(procedureInput);
    const projected = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(projected);
    for (const value of [{ procedure: "main" }, { address: "main" }]) {
      expect(validate(value)).toBe(true);
      expect(schema.parse(value)).toEqual({ procedure: "main" });
    }
    for (const value of [
      { procedure: "main", address: "main" },
      { address: 1 },
      { document: "x" },
      { procedure: "main", other: "x" },
      ["address"],
    ]) {
      expect(validate(value)).toBe(false);
      expect(schema.safeParse(value).success).toBe(false);
    }
    expect(projected).not.toHaveProperty("anyOf");
    expect(projected).toMatchObject({
      type: "object",
      properties: {
        procedure: expect.any(Object),
        document: expect.any(Object),
        address: expect.any(Object),
      },
      additionalProperties: false,
    });
  });
  it("describes an alias by its canonical spelling instead of a copy", () => {
    const projected = compatibleToolInputSchema(
      z.strictObject({
        procedure: z.string().describe("The procedure name or address"),
      }),
    )["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    expect(projected.properties).toEqual({
      procedure: {
        type: "string",
        description: "The procedure name or address",
      },
      address: { type: "string", description: "Same as procedure." },
    });
  });
  it("retains canonical value checks, defaults and cross-field refinements", () => {
    const search = compatibleToolInputSchema(searchInput);
    expect(search.parse({ query: "ACCESS" })).toEqual({
      pattern: "ACCESS",
      mode: "literal",
    });
    expect(search.safeParse({ query: "" }).success).toBe(false);
    const annotations = compatibleToolInputSchema(
      procedureInput
        .extend({ comment: z.string().optional() })
        .refine((value) => value.comment !== undefined),
    );
    expect(annotations.safeParse({ address: "main" }).success).toBe(false);
    expect(annotations.parse({ address: "main", comment: "exact" })).toEqual({
      procedure: "main",
      comment: "exact",
    });
  });
  it("advertises optional compatibility selectors without requiring a filter", () => {
    const optionalSearch = compatibleToolInputSchema(
      z.strictObject({ pattern: z.string().default("") }),
    );
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(
      optionalSearch["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      }),
    );
    for (const value of [{}, { pattern: "a" }, { query: "a" }])
      expect(validate(value)).toBe(true);
    expect(validate({ pattern: "a", query: "b" })).toBe(false);
    expect(optionalSearch.parse({})).toEqual({ pattern: "" });
  });
  it("parses canonical field transforms exactly once for each spelling", () => {
    const schema = compatibleToolInputSchema(
      z.strictObject({
        procedure: z.string().transform((value) => `${value}!`),
      }),
    );
    expect(schema.parse({ procedure: "main" })).toEqual({ procedure: "main!" });
    expect(schema.parse({ address: "main" })).toEqual({ procedure: "main!" });
  });
  it("does not wrap contracts without compatible keys", () => {
    const original = z.strictObject({ name: z.string() });
    expect(compatibleToolInputSchema(original)).toBe(original);
  });
});
