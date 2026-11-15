import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  distinctItems,
  excludedValues,
  maxCodePoints,
  requirePresence,
} from "./schemaConstraints.js";

/** The declared JSON Schema and the Zod parser accept exactly the same values. */
const expectAgreement = (schema: z.ZodType, samples: readonly unknown[]) => {
  const declared = new Ajv2020({ strict: false }).compile(
    z.toJSONSchema(schema, { io: "input" }),
  );
  for (const sample of samples)
    expect(declared(sample), JSON.stringify(sample)).toBe(
      schema.safeParse(sample).success,
    );
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
});
