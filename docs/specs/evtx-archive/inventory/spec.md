# Inventory a local Windows event log offline

Issue: https://github.com/morluto/rea/issues/9174

## Problem

Windows event logs are a first-class forensic input, but REA could not read one
without a Windows host or a live Event Log service. Analysts could not state
which records a saved `.evtx` file holds, where each record sits, or what the
file itself does and does not establish.

## Desired behavior

`inspect_evtx_archive` (MCP) and `rea inspect-evtx-archive` (CLI) read one local
`.evtx` file and return retained Evidence listing its records in file order.
Nothing outside the selected file is read: no live Event Log service is
contacted and no event-provided content is executed.

## Requirements

- Each record reports the chunk it was found in, its byte offset inside that
  64 KiB chunk, the `EventRecordID` and `SystemTime` its header states, and the
  byte extent the record declares.
- Each chunk reports its physical position as `chunk_number`, the event numbers
  and timestamps of its first and last record, and whether its header checksum
  matched. A checksum mismatch is reported, not corrected.
- A chunk is numbered by physical position, never by a value stored in the
  chunk. The first record number at `0x08` and the first record identifier at
  `0x18` are distinct header fields, and a healthy log may have them differ. A
  disagreement between the identifier at `0x18` and the first record's own
  identifier is a `first-record-id-mismatch` diagnostic.
- A wrapped log leaves stale bytes after its last record; those are not a
  truncation and do not discard the events the chunk did contain. Bytes after
  the last record are not inventoried.
- An incomplete final chunk, an undecodable chunk, a truncated record and a
  reached limit each remain diagnostics rather than ending the inventory
  silently, and a chunk without the `ElfChnk` signature is skipped while its
  neighbours are still read.
- `source_coverage` states what the inventory examined: event XML and typed
  payload values are `not-decoded`, templates are `not-resolved`, record
  checksums are `not-verified` and network is `not-contacted`. `status` is
  `complete-within-scope` only when every chunk was read without a diagnostic.

## Limits

`max_file_bytes` (64 MiB) bounds the read and `max_records` (20000) bounds the
number of records decoded; exceeding either reports a diagnostic instead of
truncating silently. Diagnostic growth is bounded separately, because one
malformed chunk can contain many bad records.

## Acceptance

- A log whose chunks hold records in file order yields every record with its
  chunk number and offset, and the documented header bytes match an
  independently computed CRC.
- A wrapped, truncated, undecodable or over-limit input keeps the events it did
  establish, states `partial` coverage and names each cause in `diagnostics`.
- An absent record never proves that an event did not occur, and that limit is
  stated in `source_coverage`.

## Non-goals

Decoding the embedded event XML, resolving typed payload values, event
templates or substitution arrays, verifying per-record checksums, correlating
against other Evidence, and reading a live log or a remote host.
