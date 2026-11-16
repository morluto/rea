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

## Private developmental sample

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
binding follows from that appearance. This implementation therefore stops at
indices and explicit unresolved alternatives rather than invent colors.

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
