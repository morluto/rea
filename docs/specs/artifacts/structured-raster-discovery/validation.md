# Structured discovery validation

## Public controls

The committed synthetic tests cover configurable grammar/endian/fields, novel
format enums, relocated tables, payload-size hypotheses, ambiguous units, logical
holes, impossible or overlapping segments, malformed container integrity, work /
record / table limits, pagination and cancellation. Thumbnail tests independently
parse PNG chunks/CRC/decompressed samples and check packed 1/2/4/8-bit fixtures.
An MCP delivery test covers the case where Evidence alone fits but appended image
blocks exceed the transport budget.

Actual public CLI tests exercise flat and FGS sources, explicit JSON grammar,
resource pagination and numeric list options. MCP tests exercise advertised
schemas, logical segments and real image content blocks. These do not establish
correctness on arbitrary firmware.

## Earlier generic baseline (before alias/family follow-up)

A local, non-distributed 5.43 MB FGS sample was inspected with the **production
implementation and defaults**, selecting only `profile: fgs-records`. No fixed
resource addresses, source hash, registry or palette location entered the search.
The selected 12-byte family is prior format knowledge, not automatically learned.
The adapter mapped 96,804 records to 4.34 MB of logical span with 78,992 uncovered
bytes. Discovery completed in roughly 0.26 seconds on this workspace; the complete
service took about 0.51 seconds. Timing is an observation, not a performance SLA.

The production scan retained four tables / 1,130 resources: 1,058 unique bpp/unit
hypotheses and 72 ambiguous. All 1,058 unique descriptor and payload byte hashes
matched annotations withheld from the search. Forty-two uncorroborated structural
tables were rejected. Ten annotated resources in another table did not reach the
size-consistency threshold and were missed. This conservative production result
is distinct from an exploratory pooled-format probe's larger unique count.

The real CLI also ran successfully, returning its default page of 128 resources,
four bounded PNG previews and a next-page offset. It needs no per-resource reverse
engineering for this supported family, but does not recover its original colors.
No private source bytes, reference manifests or generated private PNGs are part of
this PR, so this observation is not a publicly reproducible benchmark or CI test.

## Negative evidence and limits

Production defaults retained no tables in local `/bin/ls`, `/bin/bash`,
`/usr/bin/python3` or an 8 MiB seeded-noise control. A simple numerical-record
control fails the payload-size relation; deliberately structurally equivalent
non-image records can still pass. Zero accepted tables in these controls is not
a universal false-positive guarantee.

A standalone palette-looking-byte heuristic produced many plausible regions in
both the developmental sample and ordinary executables. No correct palette
binding follows from that appearance. The generic path therefore stops at
indices and explicit unresolved alternatives rather than invent colors. The
follow-up below uses explicit structural registry relationships, not this heuristic.

## Upstream integration refresh

The follow-up integrates upstream `a10037ef` rather than restoring its removed
CLI-name table or effect registry. Both commands now use the canonical contract
builder and the REA-owned command registry. Shared numeric argv projection keeps
repeated decimal dimensions, bounded fractional thresholds and numeric-literal
choices; regression tests cover their defaults, refusals and advertised schema.
The raster file owner uses the shared resource toolkit and failure classifier;
13 additional cases preserve errors before/after file admission and typed-error
identity. Cancellation and cleanup retention remain covered by source tests.

The dedicated workflow now builds the matching Windows native artifact before
its test lanes, downloads/verifies it on Windows, and runs contract-parity,
command-registry and artifact-verifier tests alongside the public raster CLI/MCP
checks. This fixes a missing Windows test prerequisite, not an image-discovery
algorithm. A local Linux pass does not establish a Windows CI pass.

## Alias-aware family and export follow-up

The alias-aware generic scanner retains five tables / 1,140 descriptors on the
same developmental sample at the unchanged 0.9 threshold: 1,058 unique and 82
ambiguous generic hypotheses. The opt-in record12/LUT family finds one registry
with six rows (including repeated table references), 1,140 unique bindings and
four palette slots. No known source address, image dimension or source hash is
supplied to discovery. The ten RGB565 resources formerly missed are retained;
generic ambiguity remains visible rather than being relabeled as certainty.

Independent production mapping → discovery → family → renderer checks matched
all 1,140 descriptor/payload hashes, 1,121 applicable LUT hashes and 1,140 decoded
RGBA outputs against withheld historical annotations. The comparison chooses one
explicit historical software interpretation (slot zero, high-six-bit expansion,
palette alpha, profile sentinels and RGB565 key). This establishes compatibility
with that software oracle, not hardware rendering truth or unseen-family recall.
The private firmware and its outputs are not distributed in this repository.

Synthetic controls cover aliases without inflated evidence, conflicting aliases,
relocation and negative bias, duplicate table-length alternatives, static/dynamic
anchor chains, unsupported formats, malformed LUTs/counts/pointers, gaps, retention
and work limits, color-policy admission, lossless RAW, PNG pixels, late cancellation,
source ownership and no-clobber/rollback publication. Deliberately structurally
equivalent numerical data can pass the family interpreter. No universal false-
positive guarantee follows from rejecting local executable/noise controls.

The shared numeric reader keeps bounds checks without allocating a Buffer view
per scalar. Local 16 MiB synthetic scan time improved from about 1.66 s to 0.44 s
for that checked-reader version; the original raw DataView baseline was about
0.27 s. At 500,000 spans, peak RSS was about 288 MiB and a queued abort waited for
a bounded synchronous segment (~264 ms in one measurement). Already-aborted
requests now stop before preprocessing. These figures are not an SLA.

All public operations use the shared service binding/recording/delivery owner.
Architecture guards and advertised-schema summaries are part of the dedicated
workflow, not inferred from a raster-only test pass. A Linux local pass does not
claim Windows execution or upstream CI approval. External schema-engine checks
must report unavailable/broken Go, RE2 or Rust engines explicitly rather than
labeling skipped engines as verified.

The reconstructed export service was also exercised end-to-end on that private
sample using only the container/family and explicit color policy. It wrote 1,140
RAW files and 1,140 full PNGs plus manifest and segment sidecar (2,282 files,
29,389,227 bytes), with all 1,140 RAW hashes and independently Pillow-decoded RGBA
hashes matching the oracle. The sidecar retained all 96,804 source segments;
the largest payload referenced 2,001 segments, beyond inspection's 256-span
projection. All 1,121 applicable LUT references reconstructed matching bytes.
The source hash was unchanged. One local run took about 6.2 seconds with about
241 MiB peak process RSS. These private-data results are not public CI fixtures
and do not establish universal discovery, hardware colors or Windows behavior.

## Review follow-up: cancellation, budgets and public schemas

Color-preview cancellation now preserves the completed discovery scan and any
already completed previews in cancellation evidence. Only the exact caller abort
reason is handled at that optional-preview boundary; unrelated failures remain
errors. Regression tests cancel the first and a later preview.

PNG rendering uses its own transient-memory ceiling independently of remaining
export disk bytes. The publication owner still admits actual encoded file sizes
and rolls back outputs when the aggregate disk ceiling is exceeded. Synthetic
filesystem regressions cover both a fitting export and disk-capacity rollback.

Explicit RGBA palettes use the shared fixed-tuple schema. Tests validate four
byte channels, reject short/long/malformed entries, and exercise the schema
returned by the public MCP tools listing. Container and logical-mapping errors
now use the shared parse-failure owner: malformed data, truncation and named
capacity limits retain their format/site/cause rather than becoming one generic
invalid-value error.

## Review follow-up: direct colors and skipped alternatives

The color-policy resolver now uses the admitted layout. Direct RGB565 resources
retain their explicit color-key policy without requiring an unrelated registry
palette. Indexed resources still require a covered palette. Service regressions
exercise both preview and full PNG export with no palette, with a disabled key
and a matching transparent key; direct-color interpretation does not claim that
palette precision, alpha, sentinels or a theme were used.

With `ambiguity=skip`, the export manifest retains the admitted alternatives
instead of only a generic skip reason. Generic alternatives include bpp/unit,
stride and corroboration evidence; family alternatives retain registry identity,
pointer bias and mapped payload/LUT/palette references. They remain evidence-only:
skipped resources do not gain executable export plans or payload files. The
references point into the complete segment sidecar rather than duplicating it.
Manifest bytes remain charged to the publication budget; highly fragmented
source mappings can still make per-alternative reference projection expensive.

These regressions use synthetic public fixtures. They do not establish new
unknown-family coverage, hardware color truth, or a fresh Windows pass.
