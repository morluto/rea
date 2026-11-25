import { expect, it } from "vitest";

import {
  analysisSearchPredicate,
  literalSubstringPredicate,
  matchedProcedureAliases,
  matchProcedureNames,
} from "./analysisSearch.js";

it("uses Unicode simple case folding for literal substrings", () => {
  const matchesSigma = literalSubstringPredicate("Σ", false);
  expect(matchesSigma("ΟΣ")).toBe(true);
  expect(matchesSigma("ος")).toBe(true);
  expect(matchesSigma("unrelated")).toBe(false);
  expect(literalSubstringPredicate("Σ", true)("ος")).toBe(false);
  expect(literalSubstringPredicate("A.B", false)("a.b")).toBe(true);
  expect(literalSubstringPredicate("A.B", false)("axb")).toBe(false);
});

it.each([
  ["Σ", "ΟΣ"],
  ["σ", "ΟΣ"],
  ["ς", "ΟΣ"],
  ["Σ", "ΣA"],
  ["foo", "FOO"],
  ["ΟΣ", "ΟΣ"],
])(
  "retains native literal match %s in %s when case is ignored",
  (pattern, value) => {
    expect(
      analysisSearchPredicate({
        pattern,
        mode: "literal",
        case_sensitive: false,
        document: undefined,
      })(value),
    ).toBe(true);
    expect(
      analysisSearchPredicate({
        pattern,
        mode: "literal",
        case_sensitive: true,
        document: undefined,
      })(value),
    ).toBe(value.includes(pattern));
    expect(
      analysisSearchPredicate({
        pattern,
        mode: "regex",
        case_sensitive: false,
        document: undefined,
      })(value),
    ).toBe(true);
  },
);

it.each([
  ["[\u03a3]+", "prefix [\u03c2]+ suffix", true],
  ["a+b", "AAAB", false],
  ["a+b", "prefix A+B suffix", true],
  ["\\", "path\\file", true],
  ["", "anything", true],
  ["𐐀", "prefix 𐐨 suffix", true],
] as const)(
  "keeps insensitive literal syntax for %s in %s",
  (pattern, value, expected) => {
    const common = { pattern, document: undefined, mode: "literal" as const };
    expect(
      analysisSearchPredicate({ ...common, case_sensitive: false })(value),
    ).toBe(expected);
    expect(
      analysisSearchPredicate({ ...common, case_sensitive: true })(value),
    ).toBe(value.includes(pattern));
  },
);

it("keeps explicit regex semantics and invalid-pattern input errors", () => {
  const common = {
    document: undefined,
    mode: "regex" as const,
    case_sensitive: false,
  };
  expect(
    analysisSearchPredicate({ ...common, pattern: "^\u03c3$" })("\u03c2"),
  ).toBe(true);
  expect(() => analysisSearchPredicate({ ...common, pattern: "[" })).toThrow(
    "search",
  );
});

it("preserves single-alias matches, primary fallback and duplicate ordering", () => {
  const row = { value: "qualified::name" };
  const matches = (name: string) => name.includes("name");
  expect(matchProcedureNames(row, ["other"], matches)).toBe(row);
  expect(matchProcedureNames(row, [row.value], matches)).toBe(row);
  expect(matchProcedureNames(row, ["name"], matches)).toEqual({
    value: row.value,
    matched_aliases: ["name"],
  });
  expect(matchProcedureNames(row, ["name", "name2", "name"], matches)).toEqual({
    value: row.value,
    matched_aliases: ["name", "name2"],
  });
});

it("handles empty patterns and Unicode simple case folding boundaries", () => {
  expect(literalSubstringPredicate("", false)("")).toBe(true);
  expect(literalSubstringPredicate("", false)("Δelta")).toBe(true);
  expect(
    analysisSearchPredicate({
      pattern: "",
      mode: "regex",
      case_sensitive: false,
      document: undefined,
    })(""),
  ).toBe(true);
  expect(literalSubstringPredicate("::123", false)("ns::123_fn")).toBe(true);
  expect(literalSubstringPredicate("::123", false)("ns:123_fn")).toBe(false);
  // Kelvin sign (U+212A) and long s (U+017F) fold to k/s under ECMAScript iu,
  // while İ (U+0130) must NOT match ASCII 'i'.
  expect(literalSubstringPredicate("sk", false)("\u017f\u212a")).toBe(true);
  expect(literalSubstringPredicate("i", false)("\u0130")).toBe(false);
});

it("deduplicates and orders matched aliases across zero, small, and large alias lists", () => {
  const matches = (value: string) => value.startsWith("hit_");
  expect(matchedProcedureAliases("hit_primary", [], matches)).toBeUndefined();
  expect(
    matchedProcedureAliases("hit_primary", ["hit_primary"], matches),
  ).toBeUndefined();
  expect(
    matchedProcedureAliases(
      "primary",
      ["miss", "hit_1", "miss", "hit_2", "hit_1", "primary"],
      matches,
    ),
  ).toEqual(["hit_1", "hit_2"]);
  const manyAliases = [
    "m0",
    "m1",
    "hit_a",
    "m2",
    "m3",
    "hit_b",
    "hit_a",
    "m4",
    "m5",
    "primary",
    "hit_c",
  ];
  expect(
    matchProcedureNames({ value: "primary" }, manyAliases, matches),
  ).toEqual({
    value: "primary",
    matched_aliases: ["hit_a", "hit_b", "hit_c"],
  });
});
