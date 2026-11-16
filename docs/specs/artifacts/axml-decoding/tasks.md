# Tasks

- [x] Define single-feature scope, contracts and implementation plan (`spec.md`, `plan.md`).
- [x] Register `axml` in the artifact format, inventory, extraction, domain and tool contract owners.
- [x] Implement `RES_XML_TYPE` admission and declared-size facts in `src/domain/axmlFormat.ts`.
- [x] Implement bounded string-pool, chunk-walk and XML projection in `src/domain/android/axmlDocument.ts`.
- [x] Implement bidirectional namespace scoping, scoped `xml:` handling and pending-declaration draining.
- [x] Implement the `axml` reader and `document.xml` extraction region via `DecodedRegionArtifactReader`.
- [x] Add synthetic layout, pool, value and malformed-carrier tests plus CLI/MCP boundary coverage.
- [x] Verify a real APK manifest decode and document the verification in the reader guide.
- [x] Update the usage guide, CLI guide, limits and skill references; pass documentation checks.
