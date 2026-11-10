# Bounded decimal-token schemas

## Proposal

Derive the advertised string-token constraint from the owning numeric field's integer bounds. Keep parser-only refinements such as power-of-two checks explicit when they cannot be represented faithfully in JSON Schema.

## Verification

Cover minimum-only, maximum-only, bounded, safe-integer, leading-zero, hexadecimal, exponent, and repeated-token fields with Ajv and the public `--schema` output.
