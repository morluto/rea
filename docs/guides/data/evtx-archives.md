# Offline Windows event log inventory

`inspect_evtx_archive` / `rea inspect-evtx-archive` reads one local Windows
Event Log (`.evtx`) file and lists its records. It never contacts a live Event
Log service, boots the source system, or executes event-provided content.

## What this version reads

Records are reported in file order. For each record the inventory keeps the
chunk it was found in, its byte offset inside that 64 KiB chunk, the
`EventRecordID` its header states, the `SystemTime` its header states, and the
byte extent the record declares. Each chunk reports its position in the file
as `chunk_number`, the event numbers and timestamps of its first and last
record, and whether its header checksum matched.

The channel, provider, event ID, level, `EventData` values and user identifiers
live inside the embedded event XML, which this version does not decode: they
are absent rather than inferred from the record number. Typed payload values,
event templates, substitution arrays and per-record checksums are likewise not
resolved.

## Sources and coverage

`source_coverage` states what the inventory examined. `event_xml` and
`typed_payload_values` are always `not-decoded`; `templates` is always
`not-resolved`. `record_checksums` is always `not-verified` and `network` is
always `not-contacted`. `status` is `complete-within-scope` only when every chunk was
read without any diagnostic; a limit, a truncated record, an undecodable chunk
or a chunk whose first record identifier disagrees with the identifier in that record
makes it `partial` and each cause appears in `diagnostics`.

A chunk is numbered by its physical position in the file, never by a value
stored in the chunk. The first event record number at `0x08` and the first
record identifier at `0x18` are distinct fields. A disagreement between the
identifier and the first record's own identifier is reported as
`first-record-id-mismatch`.

A wrapped log leaves stale bytes after its last record. Those bytes are not
reported as a truncation, and they do not discard the events the chunk did
contain.

The chunk's last-record offset bounds the last record's start, and the
free-space offset bounds its end. Bytes after the last record are not
inventoried. Invalid or inconsistent offsets leave the live region unknown and
make coverage partial. An incomplete final chunk is also reported and skipped.

## Structure and bounds

The file must start with the `ElfFile` signature and the 128-byte block header
must be at least as large as itself; anything else is reported as
`not-an-evtx-file` or `invalid-header` rather than being scanned as records. A
chunk that does not start with `ElfChnk` is skipped with `invalid-chunk`, and
its neighbours are still read.

`max_file_bytes` (64 MiB) bounds the read and `max_records` (20000) bounds the
number of records decoded; both report a diagnostic instead of silently
truncating. Diagnostic growth is bounded separately, because one malformed
chunk can contain many bad records.

## Retain the complete inventory with a summary

Use `--detail summary --evidence_output /absolute/new-evidence.bundle.json`
for counts, artifact identity and source coverage in the reply. The bundle
retains the complete parent Evidence, including the inventoried records and
diagnostics. The summary names that parent and its digest. Complete summary
projection does not imply complete source coverage; format limits, omissions
and unsupported content remain explicit in `source_coverage`.
