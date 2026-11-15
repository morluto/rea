import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { INVALID_BASE64_PADDING_PATTERN } from "../domain/stringPatterns.js";

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
  "^a{01}$",
  "^(?:ab){0,02}$",
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
      if (projection.kind === "unexpressible") {
        expect(
          presentOutputJsonSchema({ type: "string", pattern: source }),
        ).not.toHaveProperty("pattern");
        return;
      }
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
    ["^\\/", "exact", "^/[^\\x00]*(?:\\x00[^\\x00]*)*$"],
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

  it("omits the unsafe unbounded base64 padding projection", () => {
    expect(
      projectPortablePattern(INVALID_BASE64_PADDING_PATTERN.source),
    ).toEqual({ kind: "unexpressible" });
  });

  it.each(["^[^^]+$", "^[^^a]+$"])(
    "preserves the literal leading caret in %s",
    (pattern) => {
      const projected = projectPortablePattern(pattern);
      expect(projected.kind).toBe("exact");
      if (projected.kind === "unexpressible")
        throw new Error("Expected exact projection");
      for (const input of ["abc", "^", "a", "Z"])
        expect(new RegExp(projected.pattern, "u").test(input)).toBe(
          new RegExp(pattern, "u").test(input),
        );
    },
  );
});

const PRESENTERS = [
  [
    "input",
    (schema: Record<string, unknown>) =>
      presentInputJsonSchema(schema, () => undefined),
  ],
  ["output", presentOutputJsonSchema],
] as const;

describe("advertised pattern presentation", () => {
  const lookAround = "^(?!con$)[a-z]+$";
  const property = (schema: Record<string, unknown>) => ({
    type: "object",
    properties: { name: schema },
  });

  it.each(PRESENTERS)(
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

  it.each(PRESENTERS)(
    "does not narrow %s through a named anchor",
    (_kind, present) => {
      const schema = {
        $defs: {
          name: { $anchor: "name", type: "string", pattern: lookAround },
        },
        type: "object",
        properties: { name: { not: { $ref: "#name" } } },
      };
      const validate = new Ajv2020({ strict: false }).compile(present(schema));
      expect(validate({ name: "con" })).toBe(true);
    },
  );

  it.each(PRESENTERS)(
    "does not narrow %s through a URI naming this resource",
    (_kind, present) => {
      const schema = {
        $id: "https://example.test/root",
        $defs: { name: { type: "string", pattern: lookAround } },
        type: "object",
        properties: {
          name: { not: { $ref: "https://example.test/root#/$defs/name" } },
        },
      };
      const validate = new Ajv2020({ strict: false }).compile(present(schema));
      expect(validate({ name: "con" })).toBe(true);
    },
  );

  it.each(PRESENTERS)(
    "keeps %s pointers valid into locations presentation may remove",
    (_kind, present) => {
      // A widened `oneOf` becomes `anyOf`; a widened `not` or `if` is dropped.
      const widened = { type: "string", pattern: lookAround };
      const schema = {
        $defs: {
          choice: {
            oneOf: [
              { type: "string", pattern: "^\\s+$" },
              { type: "string", pattern: "^ok$" },
            ],
          },
          guard: { not: widened },
          gate: { if: widened, then: { type: "string" }, else: widened },
        },
        type: "object",
        properties: {
          choice: { $ref: "#/$defs/choice/oneOf/1" },
          negated: { $ref: "#/$defs/guard/not" },
          predicate: { $ref: "#/$defs/gate/if" },
          consequent: { $ref: "#/$defs/gate/then" },
          alternative: { $ref: "#/$defs/gate/else" },
        },
      };
      const validate = new Ajv2020({ strict: false }).compile(present(schema));
      expect(
        validate({
          choice: "ok",
          negated: "con",
          predicate: "y",
          consequent: "z",
          alternative: "w",
        }),
      ).toBe(true);
    },
  );

  it("relaxes references to nonportable schemas inside literal output data", () => {
    const literal = { type: "string", pattern: "^\\d+$" };
    const schema = presentOutputJsonSchema({
      $ref: "#/default",
      default: literal,
    });
    expect(schema.default).toEqual(literal);
    expect(schema).not.toHaveProperty("$ref");
  });
});
