import { expect, it } from "vitest";

import {
  analysisSearchPredicate,
  literalSubstringPredicate,
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
