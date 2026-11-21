import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { canonicalBase64Schema } from "./stringPatterns.js";
import { portableBundleNameSchema } from "./portableBundleName.js";
import { schemaAnnotations } from "./schemaAnnotations.js";
import {
  declaredByPatterns,
  distinctItems,
  excludedValues,
  maxCodePoints,
  jsonDocumentText,
  requirePresence,
} from "./schemaConstraints.js";

/**
 * The declared JSON Schema and the Zod parser accept the same values, or, for
 * a declaration annotated as a wider pattern approximation, the declaration
 * accepts every value parsing does.
 */
const expectAgreement = (schema: z.ZodType, samples: readonly unknown[]) => {
  const declared = new Ajv2020({ strict: false }).compile(
    z.toJSONSchema(schema, { io: "input" }),
  );
  const wider = schemaAnnotations(schema)?.patternDeclaration === "wider";
  for (const sample of samples) {
    const parsed = schema.safeParse(sample).success;
    if (wider && !parsed) continue;
    expect(declared(sample), JSON.stringify(sample)).toBe(parsed);
  }
};

describe("schema constraints", () => {
  it("declares distinct items as uniqueItems", () => {
    const schema = distinctItems(z.array(z.string()), "repeated");
    expect(z.toJSONSchema(schema)).toHaveProperty("uniqueItems", true);
    expectAgreement(schema, [[], ["a", "b"], ["a", "a"]]);
    expect(schema.safeParse(["a", "a"]).error?.issues[0]?.message).toBe(
      "repeated",
    );
  });

  it("declares excluded values as not-enum", () => {
    const schema = excludedValues(z.string(), ["RESERVED"], "reserved");
    expect(z.toJSONSchema(schema)).toHaveProperty("not", {
      enum: ["RESERVED"],
    });
    expectAgreement(schema, ["OTHER", "RESERVED"]);
  });

  it("bounds code points, the unit JSON Schema maxLength counts", () => {
    const schema = maxCodePoints(z.string(), 2, "too long");
    expect(z.toJSONSchema(schema)).toHaveProperty("maxLength", 2);
    // Two astral code points are four UTF-16 code units.
    expectAgreement(schema, ["", "ab", "abc", "\u{1F600}\u{1F600}"]);
    expect(schema.safeParse("\u{1F600}\u{1F600}").success).toBe(true);
  });

  it("declares presence rules as dependentRequired and if/then", () => {
    const schema = requirePresence(
      z.strictObject({
        target: z.string().optional(),
        offset: z.int().optional(),
        mode: z.enum(["all", "one"]).optional(),
      }),
      [
        { when: "offset", requires: "target", message: "offset needs target" },
        {
          when: "mode",
          equals: "one",
          requires: "target",
          message: "one needs target",
        },
      ],
    );
    expect(z.toJSONSchema(schema)).toMatchObject({
      dependentRequired: { offset: ["target"] },
      if: { properties: { mode: { const: "one" } }, required: ["mode"] },
      then: { required: ["target"] },
    });
    expectAgreement(schema, [
      {},
      { offset: 1 },
      { offset: 1, target: "t" },
      { mode: "all" },
      { mode: "one" },
      { mode: "one", target: "t" },
    ]);
    expect(
      schema.safeParse({ offset: 1, mode: "one" }).error?.issues,
    ).toMatchObject([
      { path: ["offset"], message: "offset needs target" },
      { path: ["mode"], message: "one needs target" },
    ]);
  });

  it("combines several value-keyed rules under allOf", () => {
    const schema = requirePresence(
      z.strictObject({
        target: z.string().optional(),
        first: z.boolean().optional(),
        second: z.boolean().optional(),
      }),
      [
        { when: "first", equals: true, requires: "target", message: "first" },
        { when: "second", equals: true, requires: "target", message: "second" },
      ],
    );
    expect(z.toJSONSchema(schema)).toHaveProperty("allOf.length", 2);
    expectAgreement(schema, [
      { first: false, second: false },
      { first: true },
      { second: true },
      { first: true, second: true, target: "t" },
    ]);
  });

  it("declares a predicate by patterns built from the same expressions", () => {
    const schema = declaredByPatterns(
      z.string(),
      (value) => value.startsWith("a") && !/b/u.test(value),
      { matches: [/^a/u], excludes: [/b/u], relation: "exact" },
      { message: "rejected" },
    );
    expect(z.toJSONSchema(schema)).toHaveProperty("allOf", [
      { pattern: "^a" },
      { not: { pattern: "b" } },
    ]);
    expect(schemaAnnotations(schema)?.patternDeclaration).toBe("exact");
    expectAgreement(schema, ["", "a", "ab", "ac", "b"]);
  });

  it("refuses pattern declarations JSON Schema cannot state", () => {
    const declare = (declaration: Parameters<typeof declaredByPatterns>[2]) =>
      declaredByPatterns(z.string(), () => true, declaration, {
        message: "rejected",
      });
    expect(() => declare({ matches: [/^app$/iu], relation: "exact" })).toThrow(
      TypeError,
    );
    expect(() => declare({ excludes: [/a/gu], relation: "wider" })).toThrow(
      TypeError,
    );
    expect(() => declare({ relation: "wider" })).toThrow(TypeError);
    expect(() =>
      declare({ matches: [], excludes: [], relation: "exact" }),
    ).toThrow(TypeError);
  });

  it("declares canonical base64 exactly", () => {
    expect(schemaAnnotations(canonicalBase64Schema)?.patternDeclaration).toBe(
      "exact",
    );
    expectAgreement(canonicalBase64Schema, [
      "",
      "AA==",
      "AB==",
      "AAA=",
      "AAB=",
      "AAAA",
      "AAAAAA==",
      "A===",
      "AA=A",
      "A",
      "AA\nA",
      "\u{1F600}AA=",
    ]);
  });

  it("declares portable bundle names by a wider pattern approximation", () => {
    expect(
      schemaAnnotations(portableBundleNameSchema)?.patternDeclaration,
    ).toBe("wider");
    expectAgreement(portableBundleNameSchema, [
      "app",
      "my-app-2",
      "con",
      "lpt1",
      "123",
      "0x1f",
      "0x",
      "1e5",
      "Upper",
      "a".repeat(63),
      "a".repeat(64),
    ]);
  });
});

it("preserves regex format issues while declaring a wider wire pattern", () => {
  const schema = declaredByPatterns(
    z.string(),
    /^[^\s]+$/u,
    { matches: [/^[^ ]+$/u], relation: "wider" },
    { message: "Whitespace is not an identity" },
  );
  const rejected = schema.safeParse("two\u00a0words");
  expect(rejected.success).toBe(false);
  if (!rejected.success)
    expect(rejected.error.issues).toMatchObject([
      {
        code: "invalid_format",
        format: "regex",
        message: "Whitespace is not an identity",
      },
    ]);
  expect(schemaAnnotations(schema)?.patternDeclaration).toBe("wider");
  expect(schema.safeParse("emulator-5554").success).toBe(true);
  expect(z.toJSONSchema(schema)).toHaveProperty("allOf", [
    { pattern: "^[^ ]+$" },
  ]);
});

describe("value requirements and JSON document text", () => {
  it("declares a rule requiring a value as if/then with a const", () => {
    const schema = requirePresence(
      z.strictObject({
        depth: z.int().optional(),
        detail: z.enum(["complete", "summary"]).optional(),
      }),
      [
        {
          when: "depth",
          requires: "detail",
          requiresValue: "summary",
          message: "depth needs summary",
        },
      ],
    );
    expect(z.toJSONSchema(schema)).toMatchObject({
      if: { required: ["depth"] },
      then: {
        required: ["detail"],
        properties: { detail: { const: "summary" } },
      },
    });
    expectAgreement(schema, [
      {},
      { depth: 1 },
      { depth: 1, detail: "complete" },
      { depth: 1, detail: "summary" },
      { detail: "complete" },
    ]);
    expect(
      schema.safeParse({ depth: 1, detail: "complete" }).error?.issues,
    ).toMatchObject([{ path: ["depth"], message: "depth needs summary" }]);
  });

  it("declares JSON document text with its content schema", () => {
    expect(
      z.toJSONSchema(jsonDocumentText(z.string(), { type: "object" })),
    ).toMatchObject({
      type: "string",
      contentMediaType: "application/json",
      contentSchema: { type: "object" },
    });
    expect(z.toJSONSchema(jsonDocumentText(z.string()))).not.toHaveProperty(
      "contentSchema",
    );
  });
});
