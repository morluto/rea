# macOS FSEvents store inspection

This specification records the first exploratory implementation increment and the
original problem statement of
[Parse macOS FSEvents stores as read-only filesystem-activity Evidence (#11350)](https://github.com/morluto/rea/issues/11350).

## Problem and outcome

Acquired macOS volumes often include compressed or uncompressed Disk Log Stream
(`.fseventsd`) files recording filesystem event notifications (`1SLD`, `2SLD`,
`3SLD`). An analyst examining an acquired file cannot inspect its event blocks,
event IDs, disk flags, or paths without relying on external parsers or live
macOS services. Add an offline, read-only inventory reader for a single
caller-selected `.fseventsd` store file, delivered in steps so maintainer scope
and contract review can happen on a bounded increment.

## Requirements

- Recognize a macOS FSEvents store file from its leading bytes: either an
  uncompressed `1SLD`, `2SLD`, or `3SLD` Disk Log Stream header (12 bytes minimum)
  or a gzip stream whose bounded initial deflate window begins with one of
  those signatures (`4+` bytes when compressed, so truncated gzip streams are
  classified and reported as malformed rather than ignored).
- Decompress single-member or concatenated multi-member gzip streams offline with
  fixed input (`16 MiB`), decompressed output (`64 MiB`), and inline sampled
  path (`256 KiB`) ceilings enforced before unbounded allocation; refuse
  over-limit streams with fixed-allowance `limit` failures.
- Support Disk Log Stream generations `1SLD` (event ID, flags, path), `2SLD`
  (adds 64-bit node ID), and `3SLD` (adds 64-bit node ID and trailing 32-bit
  word), preserving full 64-bit event IDs and node IDs as exact strings.
- Decode Darwin disk event flags (`bsd/sys/fsevents.h` store bitmasks) while
  retaining raw bitmask values (`raw`, `raw_hex`) and reporting unknown bits via
  `unknown_mask`.
- Decode NUL-terminated path strings with strict UTF-8 validation (`utf-8`) and
  fallback preview (`invalid-utf8`) while always preserving `raw_path_hex` for
  sampled records so invalid encodings do not drop original bytes.
- Track whole-stream event-ID continuity: count monotonic gaps (`current > prev + 1`),
  duplicate adjacent event IDs, out-of-order IDs (`current < prev`), and special
  markers (`Mount`, `Unmount`, `EndOfTransaction`, `TruncatedPath`).
- Return up to `32` sampled block summaries and up to `32` sampled event records
  alongside whole-file totals and up to `32` structural diagnostics.
- Clearly distinguish logged kernel/daemon notifications from proof of file
  content modification, execution, or complete volume history.

## Out of scope for this increment

- Inspecting or correlating an entire `.fseventsd` directory (`fseventsd-uuid`,
  `no_log`, store rotation across files).
- Querying or filtering records beyond the Step 1 bounded inline sample and
  whole-file counters.
- Live macOS `FSEvents` API monitoring, volume mounting, recovery of deleted
  file contents, or network access.

## Acceptance criteria for this increment

- Valid uncompressed and gzip-compressed (single- and multi-member) `1SLD`,
  `2SLD`, and `3SLD` fixtures parse deterministically under `macos-fsevents`.
- Event IDs, node IDs, flag bitmasks, and raw path bytes (including non-ASCII
  and malformed UTF-8 paths) are preserved without lossy rewriting.
- Truncated headers, truncated fixed record trailers, unterminated C-strings,
  trailing non-zero bytes, and decompression bombs hit explicit bounds or produce
  structural diagnostics cleanly.
- Parsing is completely offline and read-only using `BinaryReader` without live
  macOS services.
