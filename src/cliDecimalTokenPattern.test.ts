import { strictEqual } from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { expect, it } from "vitest";

import { cliDecimalField } from "./cli/options.js";

it("keeps advertised decimal bounds aligned across decimal-width transitions", () => {
  const ajv = new Ajv2020({ strict: false });
  for (const [minimum, maximum] of [
    [0, 0],
    [0, 16],
    [1, 9],
    [8, 12],
    [76, 256],
    [99, 100],
    [256, 65536],
    [9007199254740980, Number.MAX_SAFE_INTEGER],
  ] as const) {
    const domain = z.number().int().min(minimum).max(maximum);
    const field = cliDecimalField(domain);
    const validate = ajv.compile(z.toJSONSchema(field));
    const candidates = new Set([
      ...Array.from({ length: 1001 }, (_, index) => index),
      9_999,
      10_000,
      minimum - 1,
      minimum,
      minimum + 1,
      maximum - 1,
      maximum,
      maximum + 1,
    ]);
    for (const value of candidates) {
      if (value < 0) continue;
      const admitted = minimum <= value && value <= maximum;
      for (const token of [String(value), `000${value}`]) {
        const context = `${minimum}..${maximum}: ${token}`;
        strictEqual(validate(token), admitted, `Schema ${context}`);
        strictEqual(
          field.safeParse(token).success,
          admitted,
          `Parser ${context}`,
        );
      }
    }
  }
  // Keep every numeric spelling within the chosen range, so its syntax is
  // what causes refusal.
  const decimal = cliDecimalField(z.number().int().min(0).max(256));
  const validate = ajv.compile(z.toJSONSchema(decimal));
  for (const token of ["", "1e2", "0x10", "+1", "1.0", "1\n", " 1"]) {
    expect(validate(token), token).toBe(false);
    expect(decimal.safeParse(token).success, token).toBe(false);
  }
});

it("retains exclusive bounds, wrappers, and parser-only refinements", () => {
  const ajv = new Ajv2020({ strict: false });
  const field = cliDecimalField(
    z.number().int().gt(0).lt(10).nullable().default(2).readonly(),
  );
  const validate = ajv.compile(z.toJSONSchema(field));
  for (const value of ["0", "10", "00010", 0, 10])
    expect(validate(value)).toBe(false);
  for (const value of ["1", "09", "0009", 1, 9, null])
    expect(validate(value)).toBe(true);
  expect(field.parse(undefined)).toBe(2);
  expect(field.parse("09")).toBe(9);
  expect(field.parse(null)).toBeNull();

  const refined = cliDecimalField(
    z
      .number()
      .int()
      .min(1)
      .max(10)
      .refine((value) => value % 2 === 0),
  );
  expect(ajv.compile(z.toJSONSchema(refined))("3")).toBe(true);
  expect(refined.safeParse("3").success).toBe(false);
});

it("keeps a positive floor when the domain has no ceiling", () => {
  const ajv = new Ajv2020({ strict: false });
  for (const minimum of [1, 5, 10, 256]) {
    const field = cliDecimalField(z.number().min(minimum));
    const validate = ajv.compile(z.toJSONSchema(field));
    for (const value of [
      minimum - 1,
      minimum,
      minimum + 1,
      65536,
      9007199254740992,
      1e20,
    ]) {
      for (const token of [String(value), `000${String(value)}`])
        expect(validate(token), `${String(minimum)}..: ${token}`).toBe(
          field.safeParse(token).success,
        );
    }
    expect(validate("")).toBe(false);
  }
});
