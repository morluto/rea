# Structured discovery validation

## Reproducible public controls

Committed synthetic tests cover configurable grammar/endian/fields, relocated
tables, novel format enums, payload-size hypotheses, ambiguous units and aliases,
logical holes, overlapping segments, malformed containers, work/output bounds,
pagination and cancellation. PNG controls independently check chunks, CRCs,
decompressed pixels and packed 1/2/4/8-bit indices.

Public CLI/MCP tests cover flat and FGS sources, explicit grammar and logical
segments, numeric options, advertised schemas and image content blocks. Explicit
RGBA palette schemas preserve exactly four byte channels. Transport image-block
overflow retains the original successful Evidence rather than replacing it with
a delivery error. Completed scan and preview observations survive cancellation;
unrelated errors remain failures.

Rendering and export controls cover explicit policy, direct RGB565 without an
unused palette, matching/disabled color keys, source ownership, expected hashes,
lossless RAW, full PNG pixels and complete segment mappings. Skipped alternatives
remain concrete evidence without gaining payload files. Publication tests cover
no-clobber behavior, rollback and output capacity independently of rendering memory.

Run the dedicated raster workflow (`npm run test:raw-raster`) and the focused
service/public CLI/MCP tests named in `.github/workflows/raw-raster.yml`.
The workflow provisions matching Windows native artifacts before Windows checks.
A local Linux pass is not a Windows pass. Current executed results and exact-head
CI links belong in the PR; this document is not a historical run ledger.

## Private developmental sample

An authorized, non-distributed FGS sample was evaluated using the production
container adapter, generic scanner, opt-in registry family and full export path.
Known resource addresses, individual dimensions and the sample hash were not
search inputs. The chosen grammar family is prior format knowledge, not an
inferred ABI.

The alias-aware generic scan retained five tables and 1,140 descriptors: 1,058
unique and 82 ambiguous hypotheses. The explicit family retained 1,140 unique
bindings with registry and palette alternatives. Descriptor/payload hashes,
applicable LUT bytes and decoded pixels matched annotations withheld from search.
Full export produced 1,140 RAW and 1,140 PNG files plus manifest and complete
segment sidecar; independent pixel decoding matched the software reference and
the source hash was unchanged.

This is compatibility with one historical software interpretation under explicit
color policy, not hardware-compositing truth, unseen-family recall or publicly
reproducible CI evidence. Private firmware, images, palettes and reference
manifests are not distributed. Results from this developmental sample must not
be generalized into detector accuracy.

## Negative evidence and remaining limitations

Executable and seeded-noise controls retained no structured tables in the local
evaluation. Deliberately structurally equivalent numerical data can still pass.
Palette-looking byte regions alone do not establish a palette relationship.
Unknown grammars, compression, swizzled layouts, actual active themes and hardware
alpha/composition remain outside the demonstrated coverage.

Discovery and inspection have bounded, possibly incomplete projections. Full
export uses a separate complete segment sidecar. Cancellation is cooperative;
budgets are not process RSS guarantees. Publication can expose files before
completion and rollback is not an atomic directory rename.

Shared service binding, recording and delivery are covered separately from the
pure scanner. Architecture guards and advertised-schema checks must not be
inferred from raster-only tests. External schema engines unavailable in a given
run remain unverified. Full repository-suite completion, human review and
maintainer acceptance are separate gates, not consequences of focused tests.
