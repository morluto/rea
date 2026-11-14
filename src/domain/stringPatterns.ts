import { z } from "zod";

/** Portable ASCII identifier starting with a letter. */
export const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._\x2d]*$/u;

/** Stable evidence identifier, also admitting namespace and path separators. */
export const STABLE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:\x2f\x2d]*$/u;

// These rules are separate JSON Schema constraints. A single RE2-compatible
// regex for alphabet and quartet validity requires a repeated alphabet group;
// V8's Unicode-set engine overflows its regexp stack on that group near the
// provider's 32 MiB encoded-input budget. Wildcard quartets and literal bad
// token probes stay stack-safe at that size and compose exactly with `allOf`.
export const BASE64_QUARTET_LENGTH_PATTERN = /^(?:....)*$/;
export const INVALID_BASE64_CHARACTER_PATTERN = /[^A-Za-z0-9+\x2f=]/;
export const INVALID_BASE64_PADDING_PATTERN = /(?:=[^=]|===)/;
export const INVALID_CANONICAL_BASE64_PAD_BITS_PATTERN =
  /(?:[^AQgw]==$|[BCDFGHJKLNOPRSTVWXZabdefhijlmnpqrtuvxyz1235679+\x2f]=$)/;

// In `u` mode a well-formed surrogate pair is one code point outside this
// range, so the class matches only unpaired surrogates.
const UNPAIRED_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;

/**
 * Reject unpaired UTF-16 surrogates without advertising a pattern.
 *
 * ECMA-262 spells the surrogate block only as `\uD800-\uDFFF`. RE2 has no `\u`
 * escape and Rust's `regex` and `jsonschema` crates refuse non-scalar code
 * points, and a client that cannot compile one advertised pattern refuses the
 * complete tools request rather than the affected call. The issue keeps the
 * `invalid_format` regex shape an advertised `.regex` raises, so input issue
 * projection still reports `message`.
 */
export const rejectUnpairedSurrogates = <Schema extends z.ZodString>(
  schema: Schema,
  message: string,
): Schema =>
  schema.superRefine((value, context) => {
    if (UNPAIRED_SURROGATE_PATTERN.test(value))
      context.addIssue({
        code: "invalid_format",
        format: "regex",
        message,
        input: value,
      });
  });

export const isPaddedBase64 = (value: string): boolean =>
  value.length % 4 === 0 &&
  !INVALID_BASE64_CHARACTER_PATTERN.test(value) &&
  !INVALID_BASE64_PADDING_PATTERN.test(value);

export const isCanonicalBase64 = (value: string): boolean =>
  isPaddedBase64(value) &&
  !INVALID_CANONICAL_BASE64_PAD_BITS_PATTERN.test(value);

const paddedBase64SchemaRules = [
  { pattern: BASE64_QUARTET_LENGTH_PATTERN.source },
  { not: { pattern: INVALID_BASE64_CHARACTER_PATTERN.source } },
  { not: { pattern: INVALID_BASE64_PADDING_PATTERN.source } },
];

/** Canonical padded base64 with zero pad bits; invalid bytes never enter enclosing range checks. */
export const canonicalBase64Schema = z
  .string()
  .refine(isCanonicalBase64, {
    message: "Expected canonical padded base64",
    abort: true,
  })
  .meta({
    allOf: [
      ...paddedBase64SchemaRules,
      { not: { pattern: INVALID_CANONICAL_BASE64_PAD_BITS_PATTERN.source } },
    ],
  });
