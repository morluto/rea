# Unreal pak footer and index inspection

## Problem and outcome

Unreal Engine packages game content in `.pak` files that are often several
gigabytes. Listing what a pak contains needs only its footer and index, but no
tool reported them as Evidence. Add `inspect_unreal_pak` /
`inspect-unreal-pak`, which reads one local regular `.pak` file's footer and
the index regions the footer names and returns every index entry with the facts
the pak records about it, without extracting, decompressing or decrypting file
data. The [Unreal pak guide](../../../unreal-pak.md) describes the resulting
behavior.

## Requirements

- Decode pak versions 1 to 12. Find the footer by trying each layout's fixed
  size from the end of the file, newest first, and report the serialized
  version and footer layout (`v8a` and `v8b` share version 8) without
  attributing a version to an engine release.
- Read only the footer and the index, path hash index and full directory index
  regions; hash the whole file for artifact identity. Reject symbolic links and
  non-regular files.
- Report each entry's path (or `path: null` with its `path_hash` when only the
  path hash index exists), offset, stored and uncompressed size, compression
  method and name, block count and size as stored, encryption and deletion
  flags, and the stored SHA-1 of full records.
- Record redundant facts that disagree as `issues` (`region-hash-mismatch`,
  `duplicate-path`, `entry-count-mismatch`, `unknown-compression-slot`,
  `malformed-directory-name`, `path-hash-mismatch`) and keep decoding, making
  the contradicted fact null where the guide says so. Check version 11+ path
  hashes the way `FPakFile::HashPath` does.
- Reject structure that cannot be trusted for further reads with a typed
  reason and no partial success: unsupported footers and frozen indexes,
  out-of-bounds regions and entries, truncated records, invalid strings and
  flags, trailing bytes and unknown entry references.
- Bound the read regions (256 MiB together), entries (1,000,000), path text
  (67,108,864 UTF-16 code units) and the complete report (64 MiB), reporting
  `resource` failures with their limits. Yield every 4,096 records and stop
  there when the request is cancelled.
- Report an encrypted index as `index.state: "encrypted"` with the footer facts
  and no entries; accept no key.
- Return a compact MCP summary with counts by default, retain the complete
  Evidence, and page `entries` and `issues` through `inspect_analysis_view`
  (`unreal-pak`) by `indices`, `paths`, `kinds` and `fields`. The CLI defaults
  to complete Evidence.

## Acceptance

Synthetic fixtures cover versions 1, 3, 4 and 7 to 12, including both version
8 footer layouts, each issue kind and failure reason, resource limits,
cancellation, encrypted indexes and descriptor cleanup in unit, boundary, MCP
and CLI acceptance tests. Layouts `v2`, `v5` and `v6` are not in the synthetic
test matrix, and version 10 path hashes are not checked.
`npm run verify:unreal:pak -- --pak PATH` checks CLI and stdio MCP summary and
page parity for a caller-owned pak. A version 12 pak written by Unreal Engine
5.8.3 and 46 generated version 1 to 11 paks were compared with repak and
CUE4Parse as recorded in the guide.

## Out of scope

Extracting, decompressing or decrypting file data and accepting keys; IoStore
containers (`.utoc`/`.ucas`) and `.uasset` contents; verifying stored per-entry
SHA-1 values; attributing a pak version to an engine release; decoding
version 9 frozen indexes.
