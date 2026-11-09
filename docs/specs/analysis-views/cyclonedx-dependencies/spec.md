# CycloneDX dependency view

## Problem and outcome

REA recovers Go modules and Rust crates from shipped binaries but reports them
only in its own Evidence format, so a team feeding software composition tools
writes its own conversion, which can overstate what a binary proves. Add an
`inspect_analysis_view` / `inspect-analysis-view` kind `cyclonedx` that projects
one retained `inspect_go_binary` or `inspect_rust_binary` parent into one
deterministic CycloneDX 1.6 JSON document, with no new parser and no target
access.

## Requirements

- Accept only Go and Rust binary parents; other parents get a typed
  unsupported-target error. Read no target bytes and do not repeat the analysis.
- Produce byte-identical output for the same Evidence: no timestamp, and a
  `serialNumber` UUID derived from the parent Evidence digest.
- Describe the binary file in `metadata.component` with its file name and
  artifact SHA-256, name REA and its package version in `metadata.tools`, and
  name a selected universal Mach-O slice with `rea:macho:*` properties.
- Identify Go modules as `pkg:golang/<module path>@<version>` and crates.io
  packages as `pkg:cargo/<name>@<version>`. Keep a Go `h1:` sum as the property
  `rea:go:sum`, not a `hashes` entry. Make a module-path replacement the
  component and keep the replaced module in `rea:go:original*` properties.
- Give local Go replacements, malformed module paths (empty, `.` or `..`
  segments) and non-crates.io Rust sources no Package URL: use an indexed
  `bom-ref`, keep the source in a property and leave identity unknown.
- Set `scope: excluded` only for Rust packages whose kind is `build`. Follow the
  embedded Rust package indices for dependency edges, and relate
  `metadata.component` to a recorded Rust root package with a dependency entry
  and `rea:cargo:root`; a null root stays unknown. Record only main-module
  edges for Go and mark them with `rea:go:graph`; omit the empty `dependsOn`
  entry for a Go record that did not parse completely. Relate
  `metadata.component` to a decoded Go main module with a dependency entry and
  `rea:go:main`, even when that list is omitted; add neither without one.
- Report `compositions` as `incomplete` for partial coverage and `unknown`
  otherwise, never `complete`.
- Keep artifact identity, the parent Evidence id, a view digest, coverage,
  limitations and parent unknowns in the view, and copy unknowns and
  limitations into the document as `rea:unknown` and `rea:limitation`.
- Do not page. Refuse a document over 1,048,576 bytes with a typed error that
  names `export_evidence_bundle`, counted from a lower bound before Package URLs
  are built or edges expanded.

## Acceptance

Domain, Package URL and analysis-view service tests cover Go and Rust
projection, the digest-derived serial number, Mach-O slice properties,
replacements, local and malformed paths, a local Rust source, build scope,
edges, compositions, unsupported parents and the size refusals. CLI acceptance
and MCP boundary tests return the view for Go and Rust parents.
`npm run verify:cyclonedx:view` projects a real Go module and a `cargo auditable`
binary, checks that each projection is deterministic, and validates both
documents against the CycloneDX 1.6.1 schema and `@cyclonedx/cyclonedx-library`
([verification record](../../../verification/cyclonedx-view-2026-10-31.md)).

## Out of scope

SPDX, VEX, vulnerability lookup, signing, merging several parents, other
artifact types, and any change to the Go and Rust readers.
