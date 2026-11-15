// Advertised constructs outside the portable dialect that the presentation
// does not yet project away, counted per profile over every distinct tool
// definition the server can list (all catalog and output profiles). Counts may
// only shrink: the catalog test requires an exact match, so removing a
// construct lowers its count here, and any key not listed is enforced at zero.
// Two exceptions grow them. Each runtime analysis setting adds a branch to
// update_analysis_settings with two `const` members (`setting`, `action`), and
// the full profile also counts the Evidence bundle's required `evidence_format`
// literal (src/domain/evidenceFormat.ts) in the inputs that carry a whole
// bundle. A fix that restores a contract declaration the presentation had lost
// (for example a borrowed Evidence union advertised as an unconstrained value)
// counts its constructs again, and the PR names the restored declaration. A
// new contract or presentation construct never raises a count.

// Every advertised pattern, input and output, is enforced at zero: the
// presentation re-emits each one in the portable grammar.

/** Input-side counts, keyed by `REA_MCP_INPUT_SCHEMA_PROFILE`. */
export const ADVERTISED_INPUT_DIALECT_BASELINE: Readonly<
  Record<"compact" | "full", Readonly<Record<string, number>>>
> = {
  // The compact projection (`advertisedDialectProjection.ts`) leaves nothing
  // outside the dialect.
  compact: {},
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
    "input keyword const": 1915,
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
    "input type type-list": 53,
    "input type type:null": 6,
    "input type untyped": 1256,
  },
};
