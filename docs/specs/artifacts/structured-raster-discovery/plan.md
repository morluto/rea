# Structured raster discovery plan

- Add a bounded pure configurable table/size-consistency scanner.
- Add explicit logical-segment acquisition and a separate validated FGS-record
  container adapter. Preserve source mappings, reject overlap and uncovered reads.
- Reuse the existing source-identity, stability, cancellation, typed error and
  resource-scope workflow rather than create an untracked file reader.
- Add shared application Evidence, canonical CLI/MCP contracts and bounded
  index-only thumbnails. No automatic color-palette binding.
- Verify novel enum IDs, relocation, alternate field layouts/endian/alignment,
  holes, bad links, truncation, work/output limits, ambiguous bpp/unit inference,
  actual CLI/MCP calls and independent PNG/index decoding.
- Keep public PR draft until scope and implementation review. Private firmware,
  generated private previews and reference manifests are never committed.

## Explicit family rendering and export

The opt-in registry/LUT family retains palette and binding alternatives. Rendering
requires an explicit interpretation policy; a plausible color table alone is not
sufficient and selected software semantics do not establish hardware truth.
Full export uses the shared acquisition and publication owners, a checked source
hash, no-clobber destinations, separate output/rendering budgets and a complete
segment sidecar. Skipped alternatives remain evidence rather than executable
export plans. See [usage](../../../guides/firmware/structured-raster-discovery.md) and [validation](validation.md).
