# Implementation plan

## Boundary and contract

Add the `cyclonedx` view kind to `src/domain/analysisView/analysisViewRequest.ts`,
`analysisViewResult.ts`, `analysisView.ts` and `analysisViewParent.ts`, and to
the MCP contract in `src/contracts/analysisViewToolContracts.ts`. The CLI uses
the existing `inspect-analysis-view` request file. No new tool, provider or
parser is added.

Implement `projectCycloneDxView` and the document schema in
`src/domain/analysisView/cyclonedxView.ts`. It reads only parsed parent Evidence
and derives the serial number from the parent Evidence digest. Package URL
encoding lives in `src/domain/packageUrl.ts` (`golangPackageUrl`,
`cargoPackageUrl`). Move the shared subject checks of the Go, Rust and CycloneDX
views into `src/domain/analysisView/metadataReportSubject.ts` so
`goBinaryView.ts` and `rustBinaryView.ts` use the same owner.

## Incremental work and validation

1. Define the view request, result and MCP contract, with a typed
   unsupported-target error for other parents.
2. Implement Package URL encoding for Go module paths and crate names.
3. Project Go modules and Rust packages into components, properties, edges and
   compositions with conservative identity, and refuse oversized documents from
   a lower bound before building Package URLs or expanding edges.
4. Add domain, Package URL and service tests, CLI acceptance tests and MCP
   boundary tests for Go and Rust parents.
5. Add `scripts/verify-cyclonedx-view.mjs` (`npm run verify:cyclonedx:view`)
   to build real Go and `cargo auditable` fixtures and validate the documents
   against pinned CycloneDX 1.6.1 schema files and a CycloneDX consumer.
6. Add the [CycloneDX guide](../../../guides/native/cyclonedx-view.md), link it from the CLI,
   Go and Rust guides and the skill reference, and register its route.

## Effects and compatibility

The view reads retained Evidence only; targets are not read or executed, and
the Go and Rust readers are unchanged.
The verifier fetches schema files, checks their SHA-256 and installs its
validators only inside its temporary directory.
