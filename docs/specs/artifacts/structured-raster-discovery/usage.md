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

Do not call this a color extractor. A correct palette relationship, channel
order, LUT and transparency policy must be established separately before claiming
a faithful rendering. Automatic palette binding is intentionally absent.
