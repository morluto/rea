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

The URL supplies the context for resolving `sources` and `sourceRoot`; it is not
an instruction to fetch. Absolute virtual or file contexts can be selected as
well. The map/script association is caller-selected: a declaration or local map
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
maps and inline indexed sections. External section URLs return an actionable
unsupported-profile error. This is a defined decoder profile, not a claim to
implement every current source-map extension.

One owned Node subprocess decodes the map. Its private request directory is
removed before success is returned. Only this child's inherited `NODE_OPTIONS`
is removed; explicit V8 flags set a 192 MiB old-generation and 8 MiB semi-space
budget, one V8 worker and a 20-second deadline. Reported actual V8 heap limits
are checked. These are heap limits, not an aggregate process RSS limit. Cleanup
may extend the deadline and an unconfirmed cleanup overrides success with
`cleanup_incomplete` and the owning operation/resources.

Complete evidence is bounded by a 4 MiB map, 32 MiB codec reply, 262144 decoded
rows/segments and 64 nested section levels. Exceeding a budget returns an explicit
failure, without partial results. The existing 32 MiB manifest and 16 MiB selected
script boundaries also apply. No global toolchain or browser configuration changes
are made.

## Verification

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
