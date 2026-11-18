# auditd log inspection

This specification records the first implementation increment and the original
problem statement of
[Import Linux auditd logs as structured, offline security-event Evidence (#11345)](https://github.com/morluto/rea/issues/11345).
For current behavior and limitations, see the workflow guide once one exists.

## Problem and outcome

REA has no reader for acquired Linux audit subsystem text logs (`audit.log`).
An analyst holding a log copied from a host cannot ask which events it records,
how many records each event was written in, or whether records are duplicated,
out of order or malformed, unless `ausearch` or `aureport` is available and the
analyst lets a host tool interpret the file. Add offline, read-only inventory of
a selected auditd log, delivered in steps so each one merges on its own.

## Requirements

- Recognize an auditd log by its first line: a full
  `type=… msg=audit(<sec>.<millis>:<serial>): <body>` record, optionally
  prefixed with `node=<host>`. A file whose first line is not such a record is
  not this format. CLI and MCP target admission route it to the artifact reader.
- Join records on the whole audit event identity — timestamp seconds,
  milliseconds and serial — never the serial alone, because auditd reuses
  serials across boots and on wraparound.
- Report line, record and event totals, record counts by type across the whole
  file, malformed line count with a bounded sample of the offending lines, and
  the number of records whose event identity sorted before one already seen.
- Report interleaved events: an event whose records resumed after a later event
  started. The file's own line order is preserved and reported, never reordered
  into a tidy timeline.
- Count a repeated record type within one event by its `items=` index; a repeat
  is counted as a duplicate and only the first occurrence contributes a type
  name.
- Return the first 32 events with their identity, line span, record count and
  per-type counts, and the number of events omitted from that window. Totals
  cover the whole file.
- Bound a single line at a fixed 64 KiB ceiling and the whole file at 4 GiB,
  reporting the file ceiling as a `limit` failure with its boundary.
- Report the trailing bytes of a final line that ends without a newline.
- Report every payload gap as a limitation: key-value fields, hex and escaped
  values, argument ordering and decoded syscall or permission meanings are not
  interpreted.

## Out of scope for this increment

- Decoding record bodies: `proctitle`/`path` hex, quoted and escaped values,
  repeated fields, architecture and syscall tables, permission decoding.
- Correlating audit events with other Evidence, building attack timelines or
  making attribution claims.
- Filtering by time, event type, serial, process, executable, user or result.
- Combining several rotated or compressed log files into one timeline.
- Authenticity: a log is not treated as trustworthy, complete or tamper-free.

## Acceptance criteria for this increment

- A structurally valid fixture yields a deterministic record and event
  inventory under the `auditd-log` format.
- Records in one event join on timestamp plus serial; two events with the same
  timestamp but different serials stay separate, and so do two with the same
  serial at different times.
- A record type repeated within one event is counted and its duplicates
  reported rather than dropping the extra records.
- A record naming an earlier event after a later one began marks its event as
  interleaved and counts as out of order, with the original line order kept.
- Lines that are not auditd records are counted and sampled as diagnostics
  without dropping the valid records around them.
- A file whose first line is not an auditd record is refused as a `format`
  failure rather than producing an empty inventory.
- The inline event window is bounded at 32 while the totals cover the whole
  file.
- Parsing is offline and read-only; nothing is executed and no external
  service is contacted.
