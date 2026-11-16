# Structured indexed-raster hypotheses

Status: draft extension of the explicit raster decoder and raw candidate proposal.
This expands the original issue's scope, not a claim of maintainer approval.

## User outcome

Find candidate resource tables and inspect their packed indices without supplying
known table addresses, individual dimensions, format IDs or palette locations.
The caller selects a source representation and an explicit grammar family. This
is not arbitrary-format recognition or recovery of correct colors.

## Required separation

1. A container adapter or caller-provided segments maps file bytes into logical
   address ranges. A separately named FGS-record adapter may handle that container;
   generic discovery must not contain product names, firmware hashes or addresses.
2. A configurable grammar supplies record stride, endian, alignment and integer
   field offsets/widths. The initial family is a 12-byte little-endian dimensions /
   relative-offset layout. Its assumptions are repeated in results.
3. The scanner identifies consecutive plausible records and tests relationships:
   coverage, dimensions, monotonic offsets and byte lengths implied by geometry.
   Bits-per-pixel and offset-unit alternatives remain explicit. A tied hypothesis
   is not silently converted into a format.
4. Index-only previews show bounded grayscale thumbnails for unique, covered
   1/2/4/8-bit payload hypotheses. No palette, LUT, row orientation, bit ordering,
   transparency or original color semantics are claimed to have been inferred.

## Requirements

- S1: No known resource addresses, source hashes, registry positions, palette
  positions or enum-to-bpp map in the shared scanner. Permit configurable fields,
  record size, endianness and alignment; report the selected grammar.
- S2: Admit logical spans, file spans, allocations, work, table/record counts,
  output rows and thumbnail dimensions. Holes are not zero-filled evidence;
  overlapping logical segments are rejected rather than silently overwritten.
- S3: Count unsuccessful search work as well as accepted hypotheses. Report
  incomplete scans and truncated retained output separately; cancellation must
  preserve existing acquisition/cleanup guarantees.
- S4: Keep file-relative provenance distinct from logical addresses. A payload
  spanning container records may map to several original file-byte ranges.
- S5: Infer candidate bpp and offset-unit relationships from adjacent records;
  retain ambiguity, insufficient evidence and uncovered payloads. Payload-base
  rules are grammar hypotheses, not universally valid facts.
- S6: Make the operation callable through canonical REA CLI/MCP and shared
  application Evidence. Classification confidence is inferred. Never execute the
  artifact or modify its source bytes.
- S7: Bound previews independently of original image area. Label them index-only,
  show preview order assumptions, and do not interpret index values as alpha.

## Explicit limits

A structurally identical non-graphical table can pass. An unknown grammar,
compression, different pointer base, swizzled pixels or runtime-generated layout
may be missed. Correct table positions do not establish correct palettes.
Choosing an arbitrary plausible RGBA table would fabricate colors, so this
increment intentionally does not automatically bind palettes.

The selected family lets its users avoid reverse-engineering individual resource
addresses, but it is not a way to avoid all format knowledge. For unsupported
families, someone still has to supply a grammar or a container/segment mapping.
