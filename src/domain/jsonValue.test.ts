import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { jsonObjectSchema, jsonValueSchema } from "./jsonValue.js";

const values = [
  "text",
  0,
  false,
  null,
  [],
  {},
  { nested: [{ deeper: [1, "two", null, { three: true }] }] },
];

it("projects JSON values without recursive definitions", () => {
  for (const io of ["input", "output"] as const) {
    const schema = z.toJSONSchema(
      z.object({ value: jsonValueSchema, map: jsonObjectSchema }),
      { io },
    );
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(schema).not.toHaveProperty("$defs");
    const validate = new Ajv2020({ strict: false }).compile(schema);
    for (const value of values)
      expect(validate({ value, map: { value } })).toBe(true);
    expect(validate({ value: 1, map: [] })).toBe(false);
  }
});

it("still parses only JSON values at runtime", () => {
  for (const value of values)
    expect(jsonValueSchema.safeParse(value).success).toBe(true);
  for (const value of [undefined, Number.NaN, Infinity, () => 0, [undefined]])
    expect(jsonValueSchema.safeParse(value).success).toBe(false);
});
