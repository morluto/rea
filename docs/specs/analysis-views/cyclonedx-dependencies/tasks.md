# Tasks

- [x] Define single-feature scope, contracts and implementation plan (`spec.md`, `plan.md`).
- [x] Add the `cyclonedx` view kind to the analysis-view request, result, parent and MCP contracts.
- [x] Implement Package URL encoding in `src/domain/packageUrl.ts`.
- [x] Implement deterministic projection, conservative identity, compositions and the size refusal in `src/domain/analysisView/cyclonedxView.ts`.
- [x] Share subject checks with the Go and Rust views in `metadataReportSubject.ts`.
- [x] Add domain, Package URL, service, CLI acceptance and MCP boundary tests for Go and Rust parents.
- [x] Validate real Go and `cargo auditable` documents with `npm run verify:cyclonedx:view` ([record](../../../verification/cyclonedx-view-2026-10-31.md)).
- [x] Add the CycloneDX guide, link it from the CLI, Go and Rust guides and skill reference; pass documentation checks.
