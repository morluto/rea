# systemd journal file inspection

This specification records the first implementation increment and the original
problem statement of
[Import systemd journal files as structured, offline Linux log Evidence (#10123)](https://github.com/morluto/rea/issues/10123).
For current behavior and limitations, see the workflow guide once one exists.

## Problem and outcome

REA has no reader for acquired systemd journal files. An analyst holding a
`.journal` copied from a host or carved from a disk image cannot ask which
format revision wrote it, how many objects and entries it declares, or whether
the object chain it contains is intact, unless `journalctl` is available and
the analyst is willing to let a host tool interpret the file. Add offline,
read-only inventory of a selected journal file, delivered in steps so each one
merges on its own.

## Requirements

- Recognize a journal file by its `LPKSHHRH` header under any file name. CLI
  and MCP target admission route it to the artifact reader.
- Parse the fixed 272-byte header: compatible and incompatible flag bits with
  their names, state, file/machine/tail-entry-boot/seqnum ids, header and arena
  sizes, the four hash-table extents, object/entry/data/field/tag/entry-array
  counts, sequence numbers and the tail entry's realtime and monotonic values.
- Treat `header_size` as the object area's anchor. Require it to be at least
  272 bytes, 8-byte aligned and inside the file before walking anything;
  otherwise report zero objects and a limitation rather than guess an origin.
- Walk the object chain front to back, treating each object header's declared
  64-bit size as its extent, including the 16-byte header. Stop at the first
  object whose size is below the header size, unaligned, or past the file's
  end, and report the remaining bytes as a trailing tail.
- Report object totals, per-type counts, the valid/truncated/unknown-type
  counts, and whether any object declares compression. Object flags share their
  bit values with the compression algorithms, so the flag names are reported
  as declared.
- Return the first 32 object headers with their source offsets and the number
  of omitted headers. Aggregate counts cover the whole walked chain.
- Bound the whole file at a fixed 4 GiB ceiling and report the ceiling as a
  `limit` failure with its boundary.
- Report every payload gap as a limitation: fields, entries, entry arrays and
  hash tables are not decoded, and compressed payloads are not decompressed.

## Out of scope for this increment

- Decoding data, field, entry, entry-array and hash-table payloads, including
  repeated fields and binary values.
- Time-range, boot-id, unit, priority, executable and field filters.
- Combining entries from several files into a timeline.
- Decompression of XZ, LZ4 or ZSTD payloads.
- Authenticity: a journal is not treated as trustworthy or complete.

## Acceptance criteria for this increment

- A structurally valid fixture yields a deterministic header and object-header
  inventory under the `systemd-journal` format.
- Every flag bit the header or an object declares is named, and unknown bits
  are visible through the raw value.
- An object whose declared size overruns the file stops the walk; the prior
  objects keep their headers and the remainder is a trailing byte count.
- An object with a type outside the known range is kept and counted, not
  silently retyped.
- A file whose header cannot anchor the object area reports no objects and a
  limitation naming the declared size.
- A file shorter than the fixed header, or without the signature, is refused as
  a `format` failure.
- The inline object window is bounded at 32 while the counts cover the whole
  chain.
- Parsing is offline and read-only; nothing is decompressed or executed.
