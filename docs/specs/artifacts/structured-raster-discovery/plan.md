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

## Palette continuation

A future explicit binding may select a verified palette source, channel order,
LUT relationship and transparency policy. A plausible color table alone is not
sufficient. Data-flow/reference evidence or analyst choice must establish the
relationship before a preview is described as the original artwork.
