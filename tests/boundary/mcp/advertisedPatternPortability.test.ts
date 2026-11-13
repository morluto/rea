import { expect, it } from "vitest";

import {
  advertisedPatternFindings,
  collectAdvertisedPatterns,
} from "../../fixtures/advertisedPatternPortability.js";

// The shipped 6.9.0 pattern. It compiles in Annex B, `u` and `v` mode, which is
// why a compile-only guard passed while every client with a strict schema
// validator refused the complete tools request.
const SHIPPED =
  "^[^" +
  String.fromCharCode(92) +
  "uD800-" +
  String.fromCharCode(92) +
  "uDFFF]*$";

it("flags every spelling that names a surrogate code point", () => {
  const backslash = String.fromCharCode(92);
  for (const body of [
    "^[^" + backslash + "uD800]*$",
    "^[^" + backslash + "uDFFF]*$",
    "^[^" + backslash + "uD800-" + backslash + "uDFFF]*$",
    "^[^" + backslash + "u{D800}]*$",
    "^[^" + backslash + "x{D800}]*$",
    "^[^" + backslash + "x{dfff}]*$",
  ])
    expect(advertisedPatternFindings(body), body).not.toEqual([]);
});

it("admits escapes that stop at the surrogate boundaries", () => {
  const backslash = String.fromCharCode(92);
  for (const body of [
    "^[^" + backslash + "uD7FF]*$",
    "^[^" + backslash + "uE000]*$",
    "^[^" + backslash + "u0041]*$",
    "^[^" + backslash + "x00]*$",
    "^[a-f0-9]{64}$",
    "^[A-Za-z][A-Za-z0-9._" + backslash + "x2d]*$",
  ])
    expect(advertisedPatternFindings(body), body).toEqual([]);
});

it("admits escape spellings whose backslash is itself escaped", () => {
  const backslash = String.fromCharCode(92);
  const literal = backslash + backslash;
  for (const body of [
    "^" + literal + "uD800$",
    "^[^" + literal + "uD800-" + literal + "uDFFF]*$",
    "^" + literal + "p{Cs}$",
    "^[^" + literal + "x00]*$",
  ])
    expect(advertisedPatternFindings(body), body).toEqual([]);

  // The distinction is real, not pedantry: `\\uD800` matches the five literal
  // characters `\uD800` and names no code point, while `\uD800` names one.
  const escaped = new RegExp("^" + literal + "uD800$", "u");
  expect(escaped.test(backslash + "uD800")).toBe(true);
  expect(escaped.test(String.fromCharCode(0xd800))).toBe(false);
  expect(advertisedPatternFindings("^" + backslash + "uD800$")).not.toEqual([]);
});

it("flags property escapes, which are undefined without the u or v flag", () => {
  const backslash = String.fromCharCode(92);
  expect(advertisedPatternFindings("^[^" + backslash + "p{Cs}]*$")).not.toEqual(
    [],
  );
  expect(advertisedPatternFindings("^[^" + backslash + "p{L}]*$")).not.toEqual(
    [],
  );
  // `\p{Cs}` is the tempting substitute for the shipped pattern: it names the
  // same block and a gateway accepts it, but Annex B reads it as the literal
  // characters `p`, `{`, `C`, `s`, `}` and then rejects ordinary paths.
  const annexB = new RegExp("^[^" + backslash + "p{Cs}]*$");
  const unicode = new RegExp("^[^" + backslash + "p{Cs}]*$", "u");
  expect(annexB.test("C:" + backslash + "Users")).toBe(false);
  expect(unicode.test("C:" + backslash + "Users")).toBe(true);
});

it("does not report the shipped surrogate pattern as merely uncompilable", () => {
  // The distinction matters: a compile-only check cannot catch this defect, so
  // the portability check must not be folded back into it.
  for (const flags of ["", "u", "v"])
    expect(() => new RegExp(SHIPPED, flags), flags).not.toThrow();
  expect(advertisedPatternFindings(SHIPPED)).not.toEqual([]);
});

it("collects patterns from input and output schemas at any depth", () => {
  const backslash = String.fromCharCode(92);
  const found = collectAdvertisedPatterns({
    type: "object",
    properties: {
      path: { allOf: [{ pattern: "^[a-z]*$" }, { pattern: SHIPPED }] },
    },
    $defs: {
      inner: { items: { not: { pattern: "^" + backslash + "x00*$" } } },
    },
  });
  expect(found.map(({ where }) => where)).toEqual([
    "$/properties/path/allOf[0]/pattern",
    "$/properties/path/allOf[1]/pattern",
    "$/$defs/inner/items/not/pattern",
  ]);
  expect(
    found.filter(
      ({ pattern }) => advertisedPatternFindings(pattern).length > 0,
    ),
  ).toEqual([
    { pattern: SHIPPED, where: "$/properties/path/allOf[1]/pattern" },
  ]);
});
