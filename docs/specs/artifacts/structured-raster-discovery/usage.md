# Using structured raster discovery

This draft adds a real REA CLI command and matching MCP tool. It finds hypotheses
under a selected family, not arbitrary image formats.

## Supported-family quick start

For an FGS record container using the default 12-byte little-endian family:

```sh
rea inspect-structured-raster-candidates firmware.dnl --profile fgs-records --json > candidates.json
```

In a built checkout, replace `rea` with `node scripts/rea.mjs`. No known table
address, per-image size, firmware hash or format-ID-to-bpp mapping is supplied.
`fgs-records` validates the container's footer, declared size, CRC and record
ranges; it is not product/firmware identification. The default grammar is printed
in the result. A valid FGS file with a different resource grammar may yield no
useful results.

For already contiguous bytes use `--profile flat` (the default). `--segments`
accepts JSON records with `logicalOffset`, whole-file `fileOffset` and `length`.
The generic scanner does not infer how an unknown container maps its bytes.
Scan alignment is relative to the materialized buffer's `logicalBase`, not an
established runtime address. An unusual base/alignment may require an explicitly
selected scan alignment of one byte.
`--grammar` accepts a complete JSON grammar with record stride, endian, alignment,
field offsets/byte widths, bounds and table-end-relative payload-base hypothesis.
Unknown families still require that knowledge from an analyst or another tool.

## Reading the result

- `grammar` records the selected assumptions, not a discovered ABI.
- `tables` contain consistency measurements and resource hypotheses. `unique`
  means one retained bpp/unit hypothesis under these assumptions, not verified
  artwork. `ambiguous` alternatives remain visible; unresolved cases are not
  silently assigned a format.
- Table, descriptor and payload coordinates are **logical offsets**. Only
  `sourceMapping.ranges` are file-byte coordinates. A fragmented payload may map
  to many source ranges. Mapping output has a separate budget and `complete` flag.
- `coverage.complete` concerns the configured scan only. Record/work/table limits,
  uncovered segments and rejected uncorroborated tables remain explicit.
- `projection` reports returned/available resources and `nextResourceOffset`.
  Repeat with `--resource-offset VALUE` to inspect the next page. Check that the
  whole-file artifact hash and grammar match before treating pages as one result.

The default page is 128 resources with at most four 96-pixel thumbnails. Use
`--max-resources`, `--max-previews` and `--thumbnail-side` to reduce output; a
transport-budget error suggests these controls rather than silently dropping data.

## Seeing index previews

MCP `inspect_structured_raster_candidates` emits PNG image blocks alongside the
same Evidence, for example with arguments:

```json
{ "path": "/absolute/path/firmware.dnl", "profile": "fgs-records" }
```

These are **index-only grayscale thumbnails**, not recovered original colors.
They explicitly assume MSB-first packing and top-down rows. No palette, LUT,
transparency or row orientation is inferred. Nearest-neighbour thumbnails can
omit details.

The CLI returns the same bounded PNG data in JSON, not a graphical viewer. Save
its first preview without overwriting an existing file:

```sh
node --input-type=module -e 'import fs from "node:fs"; const e=JSON.parse(fs.readFileSync("candidates.json","utf8")); const r=e.normalized_result.tables.flatMap(t=>t.resources).find(r=>r.preview); if(!r) throw Error("No unique covered index preview in this page"); fs.writeFileSync("index-preview.png",Buffer.from(r.preview.pngBase64,"base64"),{flag:"wx"});'
```

The generic mode does not establish a palette relationship. The optional family
mode below can locate structurally corroborated LUT/palette candidates, but does
not infer which theme or alpha policy the running device uses.

## Explicit registry-family colors and full export

Select `--resource-family record12-lut-registry` only for compatible 12-byte LE
resources and pointer/count/LUT registries. This is an explicit format-family
interpreter, not universal image detection. It searches byte relationships without
known addresses or firmware IDs. It declares formats 1/2/3/4/6 as indexed
1/2/4/8-bit or little-endian RGB565, bottom-up/MSB-first. Formats 0/5 and other
families remain unsupported. Consecutive equal-offset aliases count as one
independent size equation, not extra corroboration.

`resourceFamily` retains registry alternatives, palette slots and profile-declared
bindings alongside the generic hypotheses. A generic `ambiguous` status is not
erased by the profile. `registry_selection` identifies an alternative using its
reported logical `offset` and `pointer_bias`; never select the first alternative
implicitly. Published family bindings follow the resource page. The complete
export mapping is independent of the 256-span inspection projection.

Color choices must be explicit. The following is an example interpretation, not
an assertion that slot zero, opaque alpha or disabled sentinels match a live UI:

```sh
POLICY='{"kind":"record12-lut-registry","theme_slot":0,"precision":"byte8","alpha":"opaque","sentinel":"disabled","rgb565_color_key":null}'
rea inspect-structured-raster-candidates firmware.dnl --profile fgs-records --resource-family record12-lut-registry --color-policy "$POLICY" --json > candidates.json
HASH=$(node -p 'JSON.parse(require("fs").readFileSync("candidates.json","utf8")).normalized_result.artifact.sha256')
rea export-structured-raster-resources firmware.dnl --profile fgs-records --resource-family record12-lut-registry --color-policy "$POLICY" --expected-sha256 "$HASH" --output-directory new-raster-export --json
```

Precision is `byte8` or `expand-high6`; alpha is `palette` or `opaque`; sentinels
are `profile` or `disabled`; RGB565 color key is an explicit 16-bit value or null.
A caller RGBA palette instead requires `entries`, `index_space` (`selector` or
`lookup-low-byte`) and a sentinel policy. No screen composition, active theme or
hardware compositing behavior is claimed. Default previews/export PNGs without
an explicit color policy are diagnostic, not original colors.

The matching MCP operation is `export_structured_raster_resources`, with the same
snake_case controls. It writes to a **new** directory, refuses existing files,
directories and links, and checks whole-file `expected_sha256` before output.
Source file ownership is released before publication. CLI/MCP return a compact
Evidence receipt; MCP does not inline the exported full images.

Export includes exact packed `.raw` payloads, full-size PNGs, `manifest.json` and
one complete normalized `segments.jsonl` mapping. The manifest links that sidecar
by hash and records exact source-segment references, interpretation, alternatives,
skip reasons and output hashes. RAW is lossless packed data, not a self-describing
image. Unsupported PNG interpretation can leave a valid RAW with its reason.
Default `ambiguity=skip` does not invent a choice; `all` exports separate retained
hypotheses. Explicit `selections` use reported descriptor offsets and, when needed,
bpp/offset-unit choices. Export reruns analysis and exports all retained resources,
not just the current inspection page. Incomplete discovery remains incomplete.

Hard bounds: 128 MiB input hashing, 16 MiB selected/logical bytes, 4,096 outcomes,
8,194 files and 256 MiB total output including metadata. Full PNG rendering is
limited to 4,194,304 pixels and 64 MiB transient rendering budget; RAW-only export
can avoid rendering limits. Generic and family work budgets are separate. These
budgets are not process RSS ceilings; cancellation is cooperative, not a
real-time guarantee.
No-clobber publication is not an atomic directory rename: files may be visible
before commit, and Windows inherits destination ACLs.

Evidence `parameters` preserves omitted caller controls. `resolved_controls`
records defaults separately; missing required resolved fields are rejected rather
than silently fabricated. Optional image-block overflow preserves the original
successful Evidence instead of replacing it with a delivery error.
