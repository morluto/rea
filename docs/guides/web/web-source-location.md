# Captured website source locations

`trace_web_source_location` maps one selected position in a script retained by
`export_web_scripts` through one explicitly paired local source map. The shared
CLI/MCP workflow verifies actual manifest, script and map byte identities and
returns the original position and embedded source inline. It acquires no browser,
fetches no URL and executes no application code.

```bash
rea trace-web-source-location \
  /analysis/scripts/manifest.json 0 \
  /analysis/app.js.map 'https://example.test/maps/app.js.map?v=7#context' \
  1 25 --json
```

The six positional arguments select the manifest, zero-based script index,
absolute map path, absolute map URL context, one-based generated line and
zero-based UTF-16 column. The MCP arguments are:

```json
{
  "manifest_path": "/analysis/scripts/manifest.json",
  "script_index": 0,
  "source_map": {
    "path": "/analysis/app.js.map",
    "url": "https://example.test/maps/app.js.map?v=7#context"
  },
  "generated_position": { "line": 1, "column": 25 }
}
```

The URL supplies the context for resolving `sources` and `sourceRoot` using the
ECMA-426 URL parsing rule; it is not an instruction to fetch. Repeated path
separators remain part of the resolved URL identity. A non-empty `sourceRoot`
prefixes each source, adding `/` only when the root does not already end with
one. An empty, null or omitted root adds no prefix. webpack 5 and tsc maps
(`"sourceRoot": ""`) therefore resolve against the map URL, as Chrome, Firefox
and the pinned codec do. Absolute virtual or file contexts can be selected as well. The map/script association is caller-selected: a declaration or local map
does not prove deployment authenticity or execution. Use
[import tracing](website-module-trace.md) to inspect outgoing native module edges.

## Meaning of the evidence

Lookup follows the greatest generated position less than or equal to the
selected point, across lines, and returns **every** segment at that position.
It includes generated-only mappings. This follows
[ECMA-426 GetOriginalPositions](https://tc39.es/ecma426/#sec-getoriginalpositions),
with one-based lines in REA's public contract. A point result does not establish
coverage of a source range, execution or UI causality.

Mapped entries preserve the raw source name/root, section path, section-local
source index and flattened index. Duplicate URLs remain distinct, including
entries with different embedded contents. Missing source names retain a null
resolved URL. Original coordinates outside embedded text retain the reported
coordinates and a null offset.

Embedded content hashes identify the UTF-8 encoding of the decoded
`sourcesContent` string, including its line endings. They do not identify an
independently captured original file. Raw map text is retained in Evidence's
`raw_result`, including unknown extensions; these extensions are not interpreted.
Capture context and source Evidence links accompany independently verified
selected file identities.

## Adapter and resource boundaries

The adapter uses the locked upstream
[`@jridgewell/trace-mapping` 0.3.31](https://github.com/jridgewell/trace-mapping)
without modifying its code. It validates map/VLQ structure before allocation,
normalizes nested indexed offsets before upstream flattening, checks section
boundaries and indexes, and retains raw declaration identity. It supports regular
maps and inline indexed sections. Numeric `version: 3` is required on the root
and every embedded map, including indexed ancestors. Invalid embedded headers
report their section path and cannot produce descendant mapping facts. This
uses the rejection option for version errors allowed by
[ECMA-426](https://tc39.es/ecma426/#sec-decodeindexsourcemap).
Equal section starts are allowed when earlier sections contribute no mappings;
actual decoded mappings must stay before the next section boundary.
External section URLs return an actionable
unsupported-profile error. This is a defined decoder profile, not a claim to
implement every current source-map extension.

One owned Node subprocess decodes the map. Its private request directory is
removed before success is returned. Only this child's inherited `NODE_OPTIONS`
is removed; explicit V8 flags set a 192 MiB old-generation and 8 MiB semi-space
budget, one V8 worker and `decode_timeout_ms` (default 20000). These are the defaults: select `source_map_limits.codec_heap_mib` for a different heap request. Reported actual V8 heap limits
are checked. These are heap limits, not an aggregate process RSS limit. When
REA runs on Bun, the subprocess is Bun, which ignores these V8 flags: `runtime`
records `id: "bun"`, the Bun version, its Node.js compatibility version and a
null `v8_heap_limit_bytes`. On Windows, the codec's owned Job Object then
limits its committed memory to the selected codec heap request plus a 512 MiB
reserve for Bun itself (704 MiB with the default request); `process_memory_limit_bytes` records that limit, the
limitations state it, and reaching it returns `resource_constraint` with
`codec_process_memory_limit_bytes`. Elsewhere Bun has no enforced codec limit:
`process_memory_limit_bytes` is null and the limitations state that no codec
heap limit is established. Cleanup may extend the deadline and an unconfirmed
cleanup overrides success with `cleanup_incomplete` and the owning
operation/resources.

The decoder releases its owned codec process before removing the private request
directory. A cleanup failure reports only the owners still pending: the process
run token while process release is unconfirmed, and the directory until removal
succeeds. A later successful retry settles every error bound to that command;
historical failure diagnostics remain available.

Complete evidence defaults to an 8 MiB map, 32 MiB codec reply and a shared
262144-record decoder budget. Generated rows, mapping segments, leaf maps,
source and name declarations, `sourcesContent` entries and indexed sections all
consume this budget. Generated rows and mapping segments also each have a
262144 limit; indexed maps default to 64 nested section levels. Select per-call
`source_map_limits` to change these admissions. Exceeding a budget returns an explicit
failure, without partial results. The existing 32 MiB manifest and 16 MiB selected
script boundaries also apply. No global toolchain or browser configuration changes
are made.

## Compact point delivery and retained source text

Summary delivery is useful for large point answers. Complete output can answer
a small-map task with fewer calls. The
[delivery qualification](../../verification/source-location-delivery.md)
records measured task costs and first-use discovery tradeoffs.

Complete delivery remains the default and includes raw map text and embedded source
content. Select `detail: "summary"` in MCP, or `--detail summary` with
`--evidence_output /analysis/source-point.json` in CLI, to retain the same complete
Evidence and return body-free point metadata. Summary includes source/map/manifest
identity, requested and matched generated positions, original source positions,
content digests and sizes, match count, runtime qualifications and limitations.
MCP returns the summary Evidence directly; its `normalized_result.parent_evidence_id`
identifies the complete parent. CLI returns `{ summary: <Evidence>, evidence_bundle:
{ path, bytes } }`; read `summary.normalized_result.parent_evidence_id` and use the
published bundle path for later views. The receipt byte count describes the written
complete Evidence bundle.
Delivery selection does not enter that parent's analysis parameters or change its ID.

Summary returns the first metadata page (up to 64 matches and 1 MiB), with explicit
`coverage.total`, `coverage.next_offset` and `coverage.exhausted`. Every equal-position
alternative remains in the parent, including duplicate reported names, distinct
indexed-section/source indexes and generated-only segments. Page exhaustion describes
the retained lookup alternatives; execution and deployment authenticity remain unknown.
For another page, call `inspect_analysis_view` with the same retained parent:

```json
{
  "source": {
    "kind": "retained-evidence",
    "evidence_id": "<parent_evidence_id>"
  },
  "view": {
    "kind": "source-location",
    "collection": "matches",
    "offset": 64,
    "limit": 64
  }
}
```

Source text is explicit. Select `collection: "source-text"`, an original
`match_index` from the metadata page, and UTF-16 `offset`/`limit` (default 0/1024).
For a snippet around the mapped point, use its `original_position.offset` when
known. The result preserves content digest/size and total code units, returns only
the selected text, and reports text-page coverage. Unretained or generated-only
content returns `item: null` and unavailable coverage. An offset splitting a
surrogate pair is rejected; a page never splits a complete Unicode character.

Both collections accept `max_bytes` (default 1048576), independently of their
row/code-unit limit and MCP response limits. A byte refusal names the allowance
and retained parent: select a smaller page or increase `max_bytes`, then retry
without decoding again. A large individual identity may require a larger view
allowance or complete export. Complete map text and diagnostics remain in the parent.
An optional `view` can accompany `detail: "summary"` on the initial trace, returning
that selected page immediately. `view` with complete delivery is rejected before
artifact acquisition. Summary also refuses before acquisition when session retention
or the CLI Evidence output is unavailable.

These views read retained facts even after the original map is removed. CLI can read
the saved parent with `inspect-analysis-view` and an `evidence-file` source pointing
to the written bundle; select its `evidence_id` when the bundle has multiple records.
MCP can export the complete session with `export_evidence_bundle`. A complete MCP
response that exceeds transport admission retains its parent and supplies a
`source-location` matches continuation.

## Selecting budgets and recovering the same map

Both `trace_web_source_location` and `analyze_web_bundle` accept an optional
`source_map_limits` object. Omitted fields retain the defaults above and stay
omitted in Evidence parameters. An update applies on the next call without a
REA restart. Failure text names the exact field, effective value, supported
range and next action; increasing a deadline does not change any of these
budgets.

| Field              | Default  | Scope                                                                                 |
| ------------------ | -------- | ------------------------------------------------------------------------------------- |
| `map_bytes`        | 8388608  | Local selected map admission, enforced before reading and again by the codec          |
| `output_bytes`     | 33554432 | Complete local request/reply or aggregate fetched-map representation                  |
| `decoded_rows`     | 262144   | Generated rows before upstream allocation                                             |
| `decoded_segments` | 262144   | Mapping segments before upstream allocation                                           |
| `decoded_records`  | 262144   | Shared structural work across leaves, declarations, rows, segments and sections       |
| `section_depth`    | 64       | Indexed-section nesting                                                               |
| `codec_heap_mib`   | 192      | Local codec old-generation request; process-memory enforcement remains host dependent |
| `fetch_bytes`      | 67108864 | Aggregate response bytes and, independently, resolved-identity bytes                  |

The local 8 MiB admission covers the pinned 4,284,329-byte main map and 5,529,840-byte
DateSelect map from Actual Budget without an admission retry. This is an artifact
compatibility allowance, not a context or latency optimization: complete Evidence
retains raw map text, and those two measured replies estimate 1.59 and 2.23 million
tokens. A smaller admission refuses the map; it does not compact successful
Evidence. MCP retains complete Evidence before encoding; an oversized response
returns its retained reference for `export_evidence_bundle`, or callers can use
complete CLI JSON. Select opt-in compact delivery above to keep complete Evidence accessible while returning only point metadata or an explicitly selected text page.
Browser collection keeps its separate conservative defaults; see the
[calibration record](../../verification/source-map-budget-calibration.md).

Local tracing accepts all listed fields except `fetch_bytes`. Bundle fetching
accepts all except `map_bytes` and `codec_heap_mib`: it uses its existing
inspection process rather than launching the local codec. Unsupported fields
are rejected rather than silently ignored. Byte fields are bounded below
Node's single-string representation ceiling, record fields by the signed
32-bit decoder coordinate range, section depth by the same supported count range and shared structural admission,
and heap requests by the existing 128..16384 MiB worker envelope. These bounds
remain independent; a larger map can require a larger encoded request budget
and codec heap, and the outer MCP client still owns its receive buffer/deadline.

For example, a valid 10 MiB selected local map can be retried with:

```json
{
  "source_map_limits": { "map_bytes": 16777216 }
}
```

Keep the original manifest/map/point selection in that retry. The CLI spelling
is `--source-map-bytes 8388608`; the other local flags are
`--source-map-output-bytes`, `--source-map-decoded-rows`,
`--source-map-decoded-segments`, `--source-map-decoded-records`,
`--source-map-section-depth` and `--source-map-codec-heap-mib`.
`analyze-web-bundle` instead offers `--source-map-fetch-bytes` and the shared
output/record/depth flags. Raising only `decoded_records` does not raise the
independent row or segment budgets. Failed local decoding returns no partial
point evidence; completed browser map observations retain their existing
partial/unknown semantics. Wait for retained cleanup to settle before retrying.

## Verification

Browser bundle collection uses absolute section offsets for nested inline maps.
If caller cancellation stops browser map fetching after some items complete,
the failed bundle request retains those items with the captured page in partial
Evidence and marks bundle analysis `not_performed`. This is distinct from the
local source-map decoder's failure semantics above.
An enclosing column offset contributes only when the nested section starts on
that enclosing section's first generated line. Parent boundaries still clip
preceding browser mappings when a nested section starts with a gap or has no
child leaves. Raw map text, original source identities and the dedicated decoder
profile are preserved.

Browser `original_module_edges` carry a `declaration_index` joining each edge to
its `original_sources` declaration, including repeated source URLs across indexed
sections. Imports are deduplicated within each declaration. Older observations
may omit the index; their edge declaration identity remains unknown.

Browser collection defaults to 64 MiB of map responses per inspection and
preflights indexed sections, sources, names, generated rows and mapping segments
against a 262144-record decode budget before upstream flattening. Indexed maps
default to 64 nested levels. These structural limits bound decoded object
growth while preserving large embedded `sourcesContent` strings within the
response-byte budget. It also bounds the expanded inline evidence to 32 MiB
across the inspection, checking resolved source identities and mapping rows
before publishing them, and bounds raw resolved-source identities to 64 MiB
before upstream materializes their arrays. Exceeding either decoder budget
returns a `fetch_failed` item while retaining other maps. Decoded coordinates
and source/name indexes are validated per map; a malformed map is reported as
`invalid` without discarding earlier or later maps.
Collection reserves each requested map's failure context before fetching it.
When the aggregate inline-result budget cannot reserve another item, remaining
requests are left unprocessed and reported as unknown through the top-level
`limitation`; `requested` retains the full count and `processed` counts returned
items.
Malformed UTF-8 map responses are reported as invalid rather than repaired with
replacement characters.
For browser fetching, an `invalid` map or structural or decoder capacity
failure has `artifact: null`, empty decoded arrays, and an explicit limitation.
When its bounded response body was read in full, optional `response_identity`
records that body's SHA-256 digest and byte count after HTTP content decoding
and before UTF-8 decoding. It is not a digest of partial reads or a claim that
the map was valid; historical items may omit it. Malformed text is omitted so
it does not consume the 32 MiB inline budget needed by later valid maps. A
response whose text cannot fit that budget is refused before JSON parsing and
source-map decoding, and retains the same
completed-body identity. Successful and partial maps keep their full original
text, including BOM and XSSI framing; only their parsing view removes it.

Focused tests cover duplicate mappings, indexed offsets/overlap/local indexes,
32-bit VLQ overflow, nullable content, UTF-16/CRLF positions, immutable artifact
identity, cancellation, late output closure, cleanup failures, SDK schemas and
public CLI behavior. The actual codec process is exercised on the test host.

The optional `verify:browser:source-maps` lane compiles a source-owned TypeScript
fixture with isolated esbuild 0.25.10, serves it to real Chromium, captures and
exports the actual response, then checks the original compiler point and exact
retained content through CLI and stdio MCP. It can target an installed package.
Only this lane requires Chromium and the fixture compiler. Linux x64 is the real
workflow covered by the dedicated CI job; other host workflows remain unverified.
