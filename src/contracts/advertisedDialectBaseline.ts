// Advertised constructs outside the portable dialect that the presentation
// does not yet project away, counted per profile over every distinct tool
// definition the server can list (all catalog and output profiles). Counts may
// only shrink: the catalog test requires an exact match, so removing a
// construct lowers its count here, and any key not listed is enforced at zero.

// Every advertised pattern, input and output, is enforced at zero: the
// presentation re-emits each one in the portable grammar.

/** Input-side counts, keyed by `REA_MCP_INPUT_SCHEMA_PROFILE`. */
export const ADVERTISED_INPUT_DIALECT_BASELINE: Readonly<
  Record<"compact" | "full", Readonly<Record<string, number>>>
> = {
  // The compact projection (`advertisedDialectProjection.ts`) leaves only
  // nullable values: the dialect has no null type, so advertising them as
  // their non-null type would refuse a valid input (for example `limit: null`
  // requests every remaining entry). Removing this key needs a decision to
  // admit the nullable idiom in the dialect or to narrow these inputs.
  compact: {
    "input type nullable": 29,
  },
  full: {
    "input any-of fewer-than-two-branches": 176,
    "input any-of untyped-branch": 142,
    "input boolean-schema": 1,
    "input bound maxItems": 2,
    "input bound maxLength": 30,
    "input description-length": 1,
    "input enum not-on-string-type": 1,
    "input input-bytes": 23,
    "input input-depth": 33,
    "input keyword $schema": 256,
    "input keyword allOf": 99,
    "input keyword const": 1911,
    "input keyword default": 803,
    "input keyword else": 6,
    "input keyword examples": 253,
    "input keyword exclusiveMinimum": 335,
    "input keyword format": 22,
    "input keyword if": 7,
    "input keyword minProperties": 12,
    "input keyword not": 10,
    "input keyword oneOf": 225,
    "input keyword prefixItems": 267,
    "input keyword propertyNames": 55,
    "input keyword then": 7,
    "input keyword uniqueItems": 5,
    "input type nullable": 296,
    "input type type-list": 1,
    "input type type:null": 6,
    "input type untyped": 1256,
  },
};
