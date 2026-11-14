// Advertised constructs outside the portable dialect that the presentation
// does not yet project away, counted per profile over every distinct tool
// definition the server can list (all catalog and output profiles). Counts may
// only shrink: the catalog test requires an exact match, so removing a
// construct lowers its count here, and any key not listed is enforced at zero.

/** Input-side counts, keyed by `REA_MCP_INPUT_SCHEMA_PROFILE`. */
export const ADVERTISED_INPUT_DIALECT_BASELINE: Readonly<
  Record<"compact" | "full", Readonly<Record<string, number>>>
> = {
  compact: {
    "input bound maxItems": 2,
    "input bound maxLength": 13,
    "input keyword $schema": 256,
    "input keyword allOf": 10,
    "input keyword const": 81,
    "input keyword default": 2,
    "input keyword exclusiveMinimum": 61,
    "input keyword format": 20,
    "input keyword minProperties": 12,
    "input keyword oneOf": 3,
    "input keyword prefixItems": 2,
    "input keyword propertyNames": 3,
    "input keyword uniqueItems": 2,
    "input pattern escape:\\/": 12,
    "input pattern shorthand-class": 21,
    "input pattern unanchored": 9,
    "input type type-list": 11,
    "input type type:null": 14,
    "input type untyped": 40,
  },
  full: {
    "input any-of fewer-than-two-branches": 168,
    "input any-of untyped-branch": 136,
    "input boolean-schema": 1,
    "input bound maxItems": 2,
    "input bound maxLength": 30,
    "input description-length": 1,
    "input enum not-on-string-type": 1,
    "input input-bytes": 23,
    "input input-depth": 33,
    "input keyword $schema": 256,
    "input keyword allOf": 99,
    "input keyword const": 1855,
    "input keyword default": 803,
    "input keyword else": 6,
    "input keyword examples": 253,
    "input keyword exclusiveMinimum": 335,
    "input keyword format": 22,
    "input keyword if": 7,
    "input keyword minProperties": 12,
    "input keyword not": 10,
    "input keyword oneOf": 223,
    "input keyword prefixItems": 255,
    "input keyword propertyNames": 53,
    "input keyword then": 7,
    "input keyword uniqueItems": 5,
    "input pattern dot": 5,
    "input pattern escape:\\/": 105,
    "input pattern non-ascii-or-braced-hex-escape": 1,
    "input pattern shorthand-class": 30,
    "input pattern unanchored": 98,
    "input pattern unescaped-syntax-in-class:^": 1,
    "input type type-list": 51,
    "input type type:null": 372,
    "input type untyped": 1454,
  },
};

/** Output-schema pattern counts, keyed by `REA_MCP_OUTPUT_SCHEMA_PROFILE`. */
export const ADVERTISED_OUTPUT_DIALECT_BASELINE: Readonly<
  Record<"full" | "compact" | "off", Readonly<Record<string, number>>>
> = {
  full: {
    "output pattern dot": 7,
    "output pattern escape:\\/": 7,
    "output pattern shorthand-class": 31,
    "output pattern unanchored": 29,
  },
  compact: {},
  off: {},
};
