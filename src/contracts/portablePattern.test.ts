import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
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
const bmpSamples = samples.filter(
  (value) => !/[\u{10000}-\u{10FFFF}]/u.test(value),
);

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
      // Engines differ only on astral characters (see `projectPortablePattern`):
      // V8 without `u` matches UTF-16 units, the other modes code points.
      for (const flags of ["", "v"]) {
        const mode = new RegExp(projection.pattern, flags);
        expect(
          bmpSamples
            .filter((value) => mode.test(value) !== projected.test(value))
            .map((value) => JSON.stringify(value)),
          `/${projection.pattern}/${flags}`,
        ).toEqual([]);
      }
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

  // An astral literal is two UTF-16 units in V8 without `u`; a one-or-two
  // unit atom would backtrack exponentially under a repeat.
  it.each([
    "^(a)\\1$",
    "^(?<n>a)\\k<n>$",
    "^[]$",
    "^(?i:a)$",
    "^😀$",
    "^é😀+$",
    "^[😀]$",
    "^[a😀]+$",
    "^[\\u{1F600}-\\u{1F64F}]$",
    "^[^😀]$",
  ])("omits %s, which has no portable form", (source) => {
    expect(projectPortablePattern(source)).toEqual({
      kind: "unexpressible",
    });
  });

  it("keeps a repeated class with non-ASCII members in one stack-safe class", () => {
    const projected = projectPortablePattern("^[\\t\\x20-\\x7e\\x80-\\xff]*$");
    expect(projected).toEqual({
      kind: "wider",
      pattern: "^[^\\x00-\\x08\\x0a-\\x1f\\x7f]*$",
    });
    if (projected.kind === "unexpressible") throw new Error("Expected a form");
    const large = "A".repeat(8 * 1024 * 1024);
    // V8 `v` mode overflows on any long class repetition, the source included.
    for (const flags of ["", "u"])
      expect(new RegExp(projected.pattern, flags).test(large)).toBe(true);
  });

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
    "does not narrow %s through a dynamic reference",
    (_kind, present) => {
      const schema = {
        $defs: {
          name: { $dynamicAnchor: "name", type: "string", pattern: lookAround },
        },
        type: "object",
        properties: { name: { not: { $dynamicRef: "#name" } } },
      };
      // Ajv does not resolve this dynamic anchor, so check the structure: the
      // negation of a widened target cannot remain.
      const presented = present(schema);
      expect(JSON.stringify(presented)).not.toContain(lookAround);
      expect(
        (presented.properties as Record<string, unknown>).name,
      ).not.toHaveProperty("not");
    },
  );

  it.each(PRESENTERS)(
    "does not narrow %s through a URI naming an embedded resource",
    (_kind, present) => {
      const schema = {
        $id: "https://example.test/root",
        $defs: { name: { $id: "name", type: "string", pattern: lookAround } },
        type: "object",
        properties: { name: { not: { $ref: "https://example.test/name" } } },
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
});

describe("advertised pattern presentation through pointers", () => {
  const lookAround = "^(?!con$)[a-z]+$";

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

  it.each(PRESENTERS)(
    "reads %s pointer segments by schema position, not by spelling",
    (_kind, present) => {
      // `properties` and `items` here are definition names, so the `not`
      // after each is the removable keyword, not a map entry.
      const widened = { type: "string", pattern: lookAround };
      const schema = {
        $defs: { properties: { not: widened }, items: { not: widened } },
        type: "object",
        properties: {
          first: { $ref: "#/$defs/properties/not" },
          second: { $ref: "#/$defs/items/not" },
        },
      };
      const validate = new Ajv2020({ strict: false }).compile(present(schema));
      expect(validate({ first: "con", second: "con" })).toBe(true);
    },
  );
});

it.each(PRESENTERS)(
  "keeps %s pointers valid into unevaluated keywords lost evaluation removes",
  (_kind, present) => {
    const schema = {
      $defs: {
        guard: {
          if: { pattern: "^(?!con$)[a-z]+$" },
          then: { type: "string" },
          unevaluatedProperties: { type: "string" },
          unevaluatedItems: { type: "string" },
        },
      },
      type: "object",
      properties: {
        props: { $ref: "#/$defs/guard/unevaluatedProperties" },
        items: { $ref: "#/$defs/guard/unevaluatedItems" },
      },
    };
    const validate = new Ajv2020({ strict: false }).compile(present(schema));
    expect(validate({ props: "a", items: "b" })).toBe(true);
  },
);

it.each(PRESENTERS)(
  "keeps %s pointers valid into draft-07 reference siblings relaxation removes",
  (_kind, present) => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: {
        word: { $id: "https://example.test/word", type: "object" },
      },
      type: "object",
      properties: {
        a: {
          $ref: "https://example.test/word",
          properties: { kept: { type: "string" } },
        },
        b: { $ref: "#/properties/a/properties/kept" },
        name: { type: "string", pattern: "^(?!con$)[a-z]+$" },
      },
    };
    const validate = new Ajv({ strict: false }).compile(present(schema));
    expect(validate({ a: {}, b: "x", name: "con" })).toBe(true);
  },
);

it.each(PRESENTERS)(
  "keeps %s chained pointers valid into removed draft-07 literal siblings",
  (_kind, present) => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: { word: { type: "object" } },
      type: "object",
      properties: {
        a: {
          $ref: "#/definitions/word",
          properties: { kept: { type: "string" } },
        },
        b: {
          $ref: "#/properties/a/properties/kept",
          const: { type: "string" },
        },
        c: { $ref: "#/properties/b/const" },
        name: { type: "string", pattern: "^(?!con$)[a-z]+$" },
      },
    };
    const validate = new Ajv({ strict: false }).compile(present(schema));
    expect(validate({ a: {}, b: "x", c: "y", name: "con" })).toBe(true);
  },
);

describe("advertised pattern presentation through collapsing unions", () => {
  const lookAround = "^(?!con$)[a-z]+$";

  it.each(PRESENTERS)(
    "keeps %s pointers valid into a boolean anyOf that collapses",
    (_kind, present) => {
      const schema = {
        $defs: {
          flags: {
            anyOf: [
              { type: "boolean", pattern: "^\\s+$" },
              { type: "boolean" },
            ],
          },
        },
        type: "object",
        properties: { flag: { $ref: "#/$defs/flags/anyOf/0" } },
      };
      const validate = new Ajv2020({ strict: false }).compile(present(schema));
      expect(validate({ flag: true })).toBe(true);
    },
  );

  it.each(PRESENTERS)(
    "keeps %s pointers valid into a union whose relaxed reference becomes boolean",
    (_kind, present) => {
      // Relaxing the reference into `flags` leaves `outer`'s first branch a
      // plain boolean; `outer` must still keep the branch `item` targets.
      const schema = {
        $defs: {
          flags: { anyOf: [{ type: "boolean" }, { type: "boolean" }] },
          outer: {
            anyOf: [
              { $ref: "#/$defs/flags/anyOf/0", type: "boolean" },
              { type: "boolean" },
            ],
          },
        },
        type: "object",
        properties: {
          item: { $ref: "#/$defs/outer/anyOf/1" },
          name: { type: "string", pattern: lookAround },
        },
      };
      const validate = new Ajv2020({ strict: false }).compile(present(schema));
      expect(validate({ item: true, name: "con" })).toBe(true);
    },
  );

  it.each(PRESENTERS)(
    "keeps %s pointers valid into a union whose resource reference relaxes",
    (_kind, present) => {
      // The widened sibling pattern relaxes the reference to the embedded
      // resource, leaving both branches boolean after normalization.
      const schema = {
        $defs: {
          bool: { $id: "https://example.test/bool", type: "boolean" },
          flags: {
            anyOf: [
              { $ref: "https://example.test/bool", type: "boolean" },
              { type: "boolean", pattern: "^\\s+$" },
            ],
          },
        },
        type: "object",
        properties: { flag: { $ref: "#/$defs/flags/anyOf/0" } },
      };
      const validate = new Ajv2020({ strict: false }).compile(present(schema));
      expect(validate({ flag: true })).toBe(true);
    },
  );

  it.each(PRESENTERS)(
    "does not collapse %s draft-07 references with ignored literal siblings",
    (_kind, present) => {
      // Embedded resources are unresolved here, so once a pattern widens the
      // references relax; draft-07 ignores each reference's `const` sibling.
      const schema = {
        $schema: "http://json-schema.org/draft-07/schema#",
        definitions: {
          word: { $id: "https://example.test/word", type: "string" },
          count: { $id: "https://example.test/count", type: "number" },
        },
        type: "object",
        properties: {
          value: {
            oneOf: [
              { $ref: "https://example.test/word", const: true },
              { $ref: "https://example.test/count", const: false },
            ],
          },
          name: { type: "string", pattern: lookAround },
        },
      };
      const create = () =>
        new Ajv({ strict: false, ignoreKeywordsWithRef: true });
      const canonical = create().compile(schema);
      const validate = create().compile(present(schema));
      for (const value of ["word", 1]) {
        expect(canonical({ value })).toBe(true);
        expect(validate({ value })).toBe(true);
      }
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
