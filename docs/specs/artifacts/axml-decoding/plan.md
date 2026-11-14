# Implementation plan

## Boundary and contract

Register `axml` in the existing artifact format owners:
`src/artifacts/ArtifactReader.ts`, `DecodedRegionArtifactReader.ts`,
`artifactFormats.ts`, `src/application/BinaryTargetResolver.ts`,
`src/artifacts/inventory/ArtifactGraphConstruction.ts`, plus the domain unions
in `artifactFormatMetadata.ts`, `artifactGraph.ts`, `binaryTargetTypes.ts`,
`evidenceSubject.ts`, `liveBinaryTargetSummary.ts`, `analysisSnapshot.ts` and
`analysisView/artifactInventoryView.ts`. No new tool, provider or bridge; the
CLI and MCP changes are additive through the shared reader workflows.

## Parser

`src/domain/axmlFormat.ts` owns the preamble probe and declared-size facts.
`src/domain/android/axmlDocument.ts` owns the bounded decode:

- `StringPool.parse` validates the pool header, offset table (strings plus
  styles), per-string terminators, UTF-8 extended-length fields and retained
  byte ceilings, returning a random-access `StringPool`. An opt-in
  `requireXmlChars` limit rejects characters XML 1.0 forbids.
- The chunk walk admits a single string pool, an optional resource map capped
  at the pool's string count, and node chunks; a bidirectional namespace index
  (`nsByPrefix`, `nsByUri`, `nsStack`) keeps bindings scoped both ways so
  shadowed and expired prefixes can never be emitted.
- `renderTypedValue` projects every `Res_value` type deterministically;
  `emit` accumulates output under `AXML_MAX_OUTPUT_BYTES` so attribute text
  is bounded before it is retained.

`src/artifacts/AxmlArtifactReader.ts` projects the result through
`DecodedRegionArtifactReader` as a `document.xml` region with metadata and
limitations.

## Evidence

Observed facts (counts, declared size, UTF-8 flag) populate format metadata;
skipped chunks, truncated carriers and unresolved resource IDs surface as
limitations. Malformed input fails closed as `format`; over-bound input as
`limit`. Nothing is executed.

## Tests

`tests/fixtures/axml.ts` builds synthetic documents including UTF-8/UTF-16
pools, namespaces, typed values and malformed carriers. Unit tests cover the
decoder; boundary tests cover CLI and MCP surfaces.
