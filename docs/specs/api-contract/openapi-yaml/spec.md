# OpenAPI YAML inventory

## Problem and outcome

`inspect_api_contract`'s OpenAPI profile read JSON bytes only. The YAML form is
the common distribution form of the same OpenAPI 3.x document, so a caller
holding it could not inventory operations at all. Accept `format:
"openapi-yaml"` and report the same declarations through the same canonical
parser, with `format` on the result naming the syntax that was read.

## Requirements

- Compose YAML to a JSON-compatible value in
  `src/application/apiContract/OpenApiYamlDocument.ts`, using the `yaml` package
  the repository already uses for configuration documents, and hand that value
  to the existing `parseApiContract` owner. No second OpenAPI importer.
- Refuse a repeated mapping key rather than resolving last-value-wins: after YAML
  composition which declaration the author meant is not knowable. Report
  `source_coverage.duplicate_json_members: "rejected"` for YAML and keep
  `last-value-wins` for JSON, where member order makes the rule expressible.
- Anchors, aliases, tags and comments change no reported fact.
- Present the two OpenAPI syntaxes as one MCP input group whose discriminator is
  an enum, selected with `if`/`then`/`else`; GraphQL remains the default
  alternative and runtime validation stays the canonical Zod union.

## Acceptance

CLI `rea inspect-api-contract spec.yaml` and the MCP `format` input both produce
operation slots, path-item references, diagnostics, source pointers and
source-scoped IDs identical to the JSON path for the same document. Duplicate-key,
malformed-YAML, empty-document and non-OpenAPI-YAML inputs are refused with a
diagnostic rather than an empty inventory.

## Out of scope

Reference resolution, AsyncAPI, callbacks and webhooks, schema graphs, contract
diff and traffic correlation — the remainder of #8912.
