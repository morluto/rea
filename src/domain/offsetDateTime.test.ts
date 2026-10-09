import { describe, expect, it } from "vitest";
import { z } from "zod";

import { offsetDateTimeSchema } from "./offsetDateTime.js";

/** The validator this schema replaces; it remains the oracle for the accepted set. */
const replaced = z.string().datetime({ offset: true });

const ACCEPTED: readonly (readonly [string, string])[] = [
  ["a UTC timestamp", "2026-10-09T04:00:00Z"],
  ["a positive offset", "2026-10-09T04:00:00+02:00"],
  ["a negative offset", "2026-10-09T04:00:00-03:00"],
  ["a half-hour offset", "2026-10-09T04:00:00+05:30"],
  ["a zero offset written negatively", "2026-10-09T04:00:00-00:00"],
  ["omitted seconds", "2026-10-09T04:00Z"],
  ["fractional seconds", "2026-10-09T04:00:00.123Z"],
  [
    "long fractional seconds with an offset",
    "2026-10-09T04:00:00.123456+05:30",
  ],
  ["the last second of a day", "2026-10-09T23:59:59Z"],
  ["a leap day in a divisible-by-four year", "2024-02-29T00:00:00Z"],
  ["a leap day in a divisible-by-400 century year", "2000-02-29T00:00:00Z"],
];

const REJECTED: readonly (readonly [string, string])[] = [
  ["a leap day in a non-leap year", "2023-02-29T00:00:00Z"],
  ["a leap day in a divisible-by-100 but not 400 year", "1900-02-29T00:00:00Z"],
  ["a day beyond the month length", "2026-04-31T00:00:00Z"],
  ["a month above twelve", "2026-13-01T00:00:00Z"],
  ["a month below one", "2026-00-10T00:00:00Z"],
  ["an hour above twenty-three", "2026-10-09T24:00:00Z"],
  ["an offset hour above twenty-three", "2026-10-09T04:00:00+24:00"],
  ["a missing offset", "2026-10-09T04:00:00"],
  ["a lowercase offset designator", "2026-10-09T04:00:00z"],
  ["a repeated offset designator", "2026-10-09T04:00:00ZZ"],
  ["a basic-format timestamp", "20261009T040000Z"],
  ["a date without a time", "2026-10-09"],
  ["an offset without a colon", "2026-10-09T04:00:00+0200"],
  ["a lowercase time separator", "2026-10-09t04:00:00Z"],
  ["an empty string", ""],
  ["unrelated text", "not a timestamp"],
];

const CASES = [...ACCEPTED, ...REJECTED];

describe("offset datetime schema", () => {
  it.each(ACCEPTED)("accepts %s", (_label, value) => {
    expect(offsetDateTimeSchema.safeParse(value).success).toBe(true);
  });

  it.each(REJECTED)("rejects %s", (_label, value) => {
    expect(offsetDateTimeSchema.safeParse(value).success).toBe(false);
  });

  it("classifies every case exactly as the replaced Zod validator does", () => {
    const divergences = CASES.filter(
      ([, value]) =>
        offsetDateTimeSchema.safeParse(value).success !==
        replaced.safeParse(value).success,
    ).map(([label]) => label);
    expect(divergences).toEqual([]);
  });

  it("emits a pattern that compiles in every mode a client may use", () => {
    const emitted = z.toJSONSchema(
      z.object({ observed_at: offsetDateTimeSchema }),
      { target: "draft-2020-12" },
    );
    const pattern = findPattern(emitted);
    expect(pattern).toBeDefined();
    if (pattern === undefined) return;
    // Annex B and `u` accept the pattern the replaced validator emitted; `v` does
    // not, which is the reason this schema exists.
    expect(() => new RegExp(pattern, "u")).not.toThrow();
    expect(() => new RegExp(pattern, "v")).not.toThrow();
    expect(() => new RegExp(replacedSource(), "v")).toThrow();
  });
});

const findPattern = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  if ("pattern" in value && typeof value.pattern === "string")
    return value.pattern;
  for (const entry of Object.values(value)) {
    const found = findPattern(entry);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The pattern the replaced Zod validator projects, recovered through the same path. */
const replacedSource = (): string => {
  const emitted = z.toJSONSchema(z.object({ observed_at: replaced }), {
    target: "draft-2020-12",
  });
  const pattern = findPattern(emitted);
  if (pattern === undefined)
    throw new Error("The replaced validator must project a pattern");
  return pattern;
};
