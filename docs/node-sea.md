# Node.js single executable applications

REA inventories injected Node.js SEA blobs through `inspect-artifact` /
`inspect_artifact` and materializes their contents through `extract-artifact` /
`extract_artifact`. It never runs the application or deserializes V8 snapshots
or code cache.

```sh
rea inspect-artifact ./application --json
rea inspect-artifact ./application --detail summary --evidence_output evidence.json --json
rea extract-artifact ./application --json
```

For MCP, open the carrier with `open_binary`, then call `inspect_artifact`.
Summary delivery retains the complete Evidence: use `parent_evidence_id` with
`inspect_analysis_view` to request particular inventory paths and fields.
Extraction returns a fresh `output_root`; analyze that extracted directory with
`analyze_javascript_application`. Snapshot-only applications have no recovered
main script and receive no JavaScript next probe. Neither does a main script
whose logical path lacks a JavaScript source suffix, such as `main`, because the
analyzer selects extracted files by suffix.

## Recognition and evidence

The container format is `node-sea`. REA locates Mach-O sections named
`__NODE_SEA_BLOB` in `NODE_SEA` or `__NODE_SEA`, ELF notes owned by
`NODE_SEA_BLOB`, and PE RCDATA resources named `NODE_SEA_BLOB`. PE resource
locations come from the shared PE resource parser. ELF program-header
`PT_NOTE` segments are authoritative, as at runtime; `SHT_NOTE` sections are
read only when no program-header table is readable, because injectors can
leave stale section entries. A PE without a `NODE_SEA_BLOB` resource name is
left to native classification. Universal Mach-O carriers
with different slice blobs are rejected as ambiguous; identical blobs are
inventoried once. Native carrier bytes keep their content hash and native
classification while the root occurrence represents the SEA container.

Root `format_metadata` preserves raw flags, decoded flags, code path, blob
location, exec arguments and fuse observations. Main and asset children retain
their role and exact declared name in `source_path`. Safe, noncolliding names
become logical paths after the shared NFC path normalization. Names that are
unsafe as relative paths, have an exact or file-prefix collision with another
entry, or occupy the reserved `__node_sea__`
namespace receive deterministic logical paths: `__node_sea__/main.cjs` for the
main CommonJS source and `__node_sea__/assets/<ordinal>` for assets, using their
zero-based order in the blob. The original declared name remains
in `source_path`, including an empty asset key. Snapshots and code caches use
`__node_sea__/snapshot` and `__node_sea__/code-cache`. Extraction materializes
the logical paths through the shared path-containment and collision rules and
never overwrites existing files.

The fuse scan independently records `set`, `unset`, `absent`, or `conflicting`.
An unset fuse with a present blob is reported as a limitation. These are static
sentinel observations, not proof of runtime activation: sentinel-like text in
script or asset bytes also participates in the scan.

Artifact comparison uses each member's runtime role and exact source key as
semantic metadata. Unicode-normalized graph paths do not erase differences in
runtime asset keys. For members paired at the same logical path, a directory
index change alone does not change the member. Ordinal-based fallback paths can
change when entries are reordered. When only one observation records member
metadata, the complete runtime member declaration remains unavailable. Original
source fields remain available in the retained Evidence.

## Supported layout and limits

The decoder follows the 64-bit little-endian layout in Node
[v24.10.0 node_sea.cc](https://github.com/nodejs/node/blob/v24.10.0/src/node_sea.cc)
and [node_sea.h](https://github.com/nodejs/node/blob/v24.10.0/src/node_sea.h),
including the exec-argument extension byte. Older layouts without that byte,
32-bit length fields, big-endian blobs and future flags are not supported.
Carrier byte order is independent of blob byte order.

Malformed magic, truncation, unknown flags/extensions, invalid UTF-8, duplicate
raw asset keys and conflicting blob declarations fail closed with named reasons.
Zero padding after a complete blob is allowed. Producer admission defaults to
a 256 MiB blob, 100,000 assets whose names total at most 8 MiB, and 4,096 exec
arguments totaling at most 1 MiB of text. These are resource policies, not Node
format limits. Select `artifact_limits.node_sea` on inspection or extraction to
change them before decoding names or creating records. Asset and argument
decoding, padding scans, and inventory construction
yield in bounded batches and honor caller cancellation. Asset count and name
budgets bound retained metadata independently of stored member body sizes.

| `artifact_limits.node_sea` field |   Default | Unit and admission                                     |
| -------------------------------- | --------: | ------------------------------------------------------ |
| `blob_bytes`                     | 268435456 | Bytes in one blob, checked before reading and decoding |
| `asset_count`                    |    100000 | Asset records                                          |
| `asset_name_bytes`               |   8388608 | Aggregate raw UTF-8 asset-name bytes                   |
| `argument_count`                 |      4096 | Exec-argument records                                  |
| `argument_bytes`                 |   1048576 | Aggregate raw UTF-8 exec-argument bytes                |
| `recognition_header_count`       |      4096 | ELF header rows admitted for recognition               |
| `recognition_load_command_bytes` |   8388608 | Mach-O load-command bytes admitted for recognition     |

Exhausted recognition remains unknown, not examined absence. Inventory preserves
native-root facts or another positively recognized pack and records the exact
recognition limit inline. If extraction cannot establish a supported pack, it
refuses with that admission cause. Confirmed SEA blob admission still returns a
typed resource failure. ELF note-owner matching reads only the prefix needed to distinguish
`NODE_SEA_BLOB`; an unrelated long owner does not consume retained string space
or conceal a later SEA note. This does not change malformed framing checks.

For example, retain the same active carrier and retry an argument-count refusal:

```json
{ "artifact_limits": { "node_sea": { "argument_count": 8192 } } }
```

The CLI spelling is:

```sh
rea inspect-artifact ./application --artifact-limits '{"node_sea":{"argument_count":8192}}' --json
```

Failures report `reader_limit`, including the exact parameter, effective value,
unit, supported range and required value when known. Changes apply on the next
call without restarting REA. Delivery summary, paging and extraction selection
cannot bypass whole-manifest admission. Omitted selections stay omitted in
Evidence parameters; selecting `artifact_limits` records the accepted selection
and `effective_limits`. Those are conditional policies for encountered readers,
not a claim that every listed format was examined. The independent aggregate
member-work override is `artifact_limits.expanded_bytes`; omission keeps the
encoded-size-derived work allowance. Runtime Buffer/string representation limits
and host memory remain independent of larger selected budgets.

PE carriers additionally use the shared 512 MiB input, 65,536 directory-entry
and 8 MiB resource-metadata ceilings; the Node SEA selections do not raise those
shared PE-parser boundaries. The PE name probe reads headers from the first
64 KiB of the carrier; a PE whose
headers extend beyond that is left to native classification. ELF note tables
are read for at most one note per 12 carrier bytes in total, the most that
disjoint tables can hold, so program headers that repeat the same notes do not
rescan them once per header. Past that count the remaining tables are
unreadable: an ELF without a confirmed blob keeps its native classification,
and one with a blob fails closed. Snapshot and code-cache bytes remain opaque.

## Verification

Synthetic fixtures cover Mach-O, ELF and PE inventory/extraction, malformed
blobs, collisions and fuse contradictions. CLI and MCP tests exercise the same
artifact provider and advertised schemas. A CLI regression also generates a blob
with the pinned local Node version, an absolute main path and an empty asset
key, then inventories it inside a synthetic ELF carrier. This verifies the real
blob producer, not a real injected executable.

The optional real ELF lane uses Docker's official Node v24.10.0 image and pinned
postject to build a fixture, then verifies inventory and extracted script/asset
bytes without running the injected application:

```sh
npm run verify:node-sea
```

This requires Docker and network access to fetch the producer image and
postject. It creates and removes its own temporary fixture directory. A real
macOS Mach-O or Windows PE run is separate coverage; synthetic carriers do not
establish real-platform verification. No performance improvement is claimed;
whole-task tokens, CPU, memory, and cold/warm timings have not been measured.
