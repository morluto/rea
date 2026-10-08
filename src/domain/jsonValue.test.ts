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

it("preserves prototype-named members without prototype mutation", () => {
  const input = JSON.parse(
    '{"__proto__":{"preserved":7},"constructor":"ordinary","prototype":[1],"nested":{"\\u005f\\u005fproto\\u005f\\u005f":"escaped"},"list":[{"__proto__":null}]}',
  ) as Record<string, unknown>;
  expect(Object.hasOwn(input, "__proto__")).toBe(true);
  const parsed = jsonValueSchema.parse(input) as Record<string, unknown>;
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  for (const key of ["__proto__", "constructor", "prototype", "nested", "list"])
    expect(Object.hasOwn(parsed, key)).toBe(true);
  expect(parsed["__proto__"]).toEqual({ preserved: 7 });
  expect(parsed["constructor"]).toBe("ordinary");
  expect(parsed["prototype"]).toEqual([1]);
  const nested = parsed["nested"] as Record<string, unknown>;
  expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
  expect(Object.hasOwn(nested, "__proto__")).toBe(true);
  expect(nested["__proto__"]).toBe("escaped");
  const list = parsed["list"] as readonly unknown[];
  const first = list[0] as Record<string, unknown>;
  expect(Object.hasOwn(first, "__proto__")).toBe(true);
  expect(first["__proto__"]).toBeNull();
  expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
  expect(({} as Record<string, unknown>)["preserved"]).toBeUndefined();
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(
    JSON.parse(JSON.stringify(input)),
  );
});
