# Implementation plan

## Boundary and contract

`src/domain/apiContract/parseApiContract.ts` stays the only producer of OpenAPI
declarations. `OpenApiYamlDocument.ts` is an input adapter in front of it: it
composes YAML into the same JSON-compatible value the JSON profile parses, so no
superseded path is retained and coverage, pointers and IDs are produced by one
implementation.

`format`/`contractFormat` gains the additive value `openapi-yaml`; the tool
description, `--help` and the advertised input schema name the new syntax. The
input group presenter selects the OpenAPI group with `if`/`then`/`else` over the
enum discriminator instead of a single `const`.

## Incremental work and validation

1. Add the YAML decoder and route it behind `format: "openapi-yaml"`, sharing the
   canonical parser and diagnostic vocabulary.
2. Extend `source_coverage.duplicate_json_members` with `rejected` for YAML and
   cover duplicate keys, anchors/aliases and tags.
3. Extend the advertised-schema presenter for the enum discriminator, keeping
   the JSON profile's shape unchanged.
4. Test CLI and MCP parity against the same YAML and JSON fixtures, including
   refusal paths.

## Effects and compatibility

The change is additive for JSON callers: the same input yields the same result.
YAML input is new, and its duplicate-key rule differs from JSON's in the case
JSON could express and YAML cannot.
