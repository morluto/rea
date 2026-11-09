# Tasks

- [x] Add `OpenApiYamlDocument.ts` and the `format: "openapi-yaml"` route through the canonical OpenAPI parser.
- [x] Report `duplicate_json_members: "rejected"` for YAML; keep `last-value-wins` for JSON.
- [x] Present both OpenAPI syntaxes as one enum-discriminated input group in the advertised schema.
- [x] Cover YAML/JSON parity, duplicate keys, anchors/aliases/tags and refusal paths in tests.
- [x] Name the new syntax in the tool description, `--help` and the API contract guide.
