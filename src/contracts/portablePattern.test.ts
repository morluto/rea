import { describe, expect, it } from "vitest";

import { portablePatternViolations } from "./advertisedDialect.js";
import {
  presentInputJsonSchema,
  presentOutputJsonSchema,
} from "./inputSchemaPresentation.js";
import { projectPortablePattern } from "./portablePattern.js";

// Short strings over an alphabet that reaches every class boundary the
// projection reasons about: ASCII letters, digits, punctuation, whitespace,
// line terminators, NUL, non-ASCII spaces and letters, and a lone surrogate.
const ALPHABET = [
  "a",
  "Z",
  "0",
  "7",
  "_",
  "-",
  "/",
  "\\",
  ".",
  "=",
  "+",
  "^",
  "$",
  "[",
  " ",
  "\t",
  "\n",
  "\r",
  "\0",
  " ",
  " ",
  "é",
  "😀",
  "\ud800",
  "A",
  "Q",
  "x",
  "c",
  "o",
  "n",
];

const samples = (() => {
  const strings = new Set<string>([""]);
  let state = 0x5eed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state;
  };
  for (const character of ALPHABET) strings.add(character);
  for (let index = 0; index < 4000; index++) {
    let value = "";
    const length = next() % 9;
    for (let position = 0; position < length; position++)
      value += ALPHABET[next() % ALPHABET.length];
    strings.add(value);
  }
  return [...strings];
})();

const SOURCES = [
  // Advertised before projection (input and output catalogs).
  "^\\/",
  "^-?\\d+$",
  "^[^\\s\\x5b\\x5d]+$",
  "^[^\\x00\\s\"']+$",
  "^(?:....)*$",
  "[^A-Za-z0-9+\\x2f=]",
  "(?:=[^=]|===)",
  "(?:[^AQgw]==$|[BCDFGHJKLNOPRSTVWXZabdefhijlmnpqrtuvxyz1235679+\\x2f]=$)",
  "^1\\.0\\.\\d+$",
  "^\\x2F(?:[^\\x2F\\x5C]|$)",
  "^(?:\\/.*)?$",
  "^[!#$%&'*+.^_`\\x7C~0-9A-Za-z\\x2D]+$",
  "^[\\t\\x20-\\x7e\\x80-\\xff]*$",
  "^[\\w .:@\\x2f+\\x2d]+$",
  "^https?:\\/\\/",
  "^INVOKE_",
  "^[\\x01-\\x20]*(?:\\+|-)?(?:NaN|Infinity|(?:(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE](?:\\+|-)?\\d+)?[fFdD]?|0[xX](?:[\\da-fA-F]+(?:\\.[\\da-fA-F]*)?|\\.[\\da-fA-F]+)[pP](?:\\+|-)?\\d+[fFdD]?))[\\x01-\\x20]*$",
  // Constructs other engines refuse.
  "^[^\\0]*$",
  "^[^\\uD800-\\uDFFF]*$",
  "^[A-Za-z0-9._-]+$",
  "^[a-z0-9]+(?:-[a-z0-9]+)*(?![\\s\\S])",
  "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)",
  "^(?!\\.\\.?$)[^/]+$",
  "^[^]$",
  "a|^b|c$",
  "^\\p{L}+$",
  "^\\bcon\\b",
  "^a{2,1001}$",
  "^(?<word>[a-z]+)-x$",
  "^\\u0041\\u{42}\\cJ$",
  "^\\S\\W\\D$",
  "^[\\S]$",
  "^[^\\D]$",
  "^é+$",
];

describe("portable pattern projection", () => {
  it.each(SOURCES)(
    "re-emits %s inside the grammar and its declared relation",
    (source) => {
      const projection = projectPortablePattern(source);
      expect(projection.kind).not.toBe("unexpressible");
      if (projection.kind === "unexpressible") return;
      expect(portablePatternViolations(projection.pattern)).toEqual([]);
      for (const flags of ["", "u", "v"])
        expect(() => new RegExp(projection.pattern, flags)).not.toThrow();
      const original = new RegExp(source, "u");
      const projected = new RegExp(projection.pattern, "u");
      const differences = samples.filter(
        (value) => original.test(value) !== projected.test(value),
      );
      if (projection.kind === "exact")
        expect(differences.map((value) => JSON.stringify(value))).toEqual([]);
      else
        // A wider projection may only admit more strings.
        expect(
          differences
            .filter((value) => original.test(value))
            .map((value) => JSON.stringify(value)),
        ).toEqual([]);
    },
  );

  it.each([
    ["^\\d+$", "exact", "^[0-9]+$"],
    ["^[A-Za-z0-9._-]+$", "exact", "^[\\-.0-9A-Z_a-z]+$"],
    ["^\\/", "exact", "^\\/[^\\x00]*(?:\\x00[^\\x00]*)*$"],
    ["^(?!con$)[a-z]+$", "wider", "^[a-z]+$"],
    ["^[^\\x00\\s\"']+$", "wider", "^[^\\x00\\x09-\\x0d \"']+$"],
  ])("projects %s %s as %s", (source, kind, pattern) => {
    expect(projectPortablePattern(source)).toEqual({ kind, pattern });
  });

  it.each(["^(a)\\1$", "^(?<n>a)\\k<n>$", "^[]$", "^(?i:a)$"])(
    "omits %s, which has no portable form",
    (source) => {
      expect(projectPortablePattern(source)).toEqual({
        kind: "unexpressible",
      });
    },
  );
});

describe("advertised pattern presentation", () => {
  const lookAround = "^(?!con$)[a-z]+$";
  const property = (schema: Record<string, unknown>) => ({
    type: "object",
    properties: { name: schema },
  });

  it.each([
    [
      "input",
      (schema: Record<string, unknown>) =>
        presentInputJsonSchema(schema, () => undefined),
    ],
    ["output", presentOutputJsonSchema],
  ] as const)(
    "keeps only widening around a widened %s pattern",
    (_kind, present) => {
      // Widening a pattern under `not` would narrow the enclosing schema.
      const negated = present(
        property({ type: "string", not: { pattern: lookAround } }),
      );
      expect(negated).toEqual(property({ type: "string" }));
      // Exact re-emission keeps the negation.
      expect(
        present(property({ type: "string", not: { pattern: "^\\d+$" } })),
      ).toEqual(property({ type: "string", not: { pattern: "^[0-9]+$" } }));
      // A widened branch could match alongside a sibling, so `oneOf` becomes `anyOf`.
      expect(
        present(
          property({
            oneOf: [
              { type: "string", pattern: lookAround },
              { type: "string", pattern: "^con$" },
            ],
          }),
        ),
      ).toEqual(
        property({
          anyOf: [
            { type: "string", pattern: "^[a-z]+$" },
            { type: "string", pattern: "^con$" },
          ],
        }),
      );
    },
  );

  it("returns an output schema without non-portable patterns unchanged", () => {
    const schema = property({ type: "string", pattern: "^[a-z]+$" });
    expect(presentOutputJsonSchema(schema)).toBe(schema);
  });
});
