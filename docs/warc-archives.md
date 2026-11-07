# Offline WARC archive inventory

`inspect_warc_archive` / `rea inspect-warc-archive` reads one local WARC or
WARC.gz file and lists its records. It never fetches a target URI, replays a
request, executes archived content or reads a file outside the selection.

## What this version reads

Records are reported in archive order. For each record the inventory keeps the
version line, `WARC-Type`, `WARC-Date`, `WARC-Record-ID`, `WARC-Target-URI`,
`Content-Type`, the declared `Content-Length`, `WARC-Block-Digest`,
`WARC-Payload-Digest`, `WARC-IP-Address`, `WARC-Profile`,
`WARC-Segment-Number` and the byte extent the record actually occupies.
`response` records also carry the embedded HTTP status line.

Record payloads, further HTTP headers and HTTP bodies are not decoded. Declared
digests are reported as written and are not verified. Records are not linked to
each other by `WARC-Record-ID` or payload digest. A `revisit` record stays a
record; it is not resolved to the response it refers to.

Unknown `WARC-Type` values stay in the list with `record_type_known: false`
instead of being dropped, so an archive whose vocabulary is newer than this
reader still inventories completely.

## Sources and coverage

`source_coverage` states what the inventory examined. `payloads` and
`http_bodies` are always `not-decoded`, `digests` is always `not-verified`, and
`related_records` is always `not-linked`. `status` is `complete-within-scope`
only when every record in the decoded stream was read; a limit, a truncated
record or a malformed header makes it `partial` and each cause appears in
`diagnostics`.

## Compression

Identity WARC and gzip-compressed WARC are supported. A WARC.gz file that
concatenates several gzip members is decoded as one stream. Compression
detection is gzip magic, so any other format (a ZIP, for instance) is read as
identity bytes and reports `not-a-warc-stream` — an undecodable gzip member
likewise reports `unsupported-compression`. A stream that would exceed
`max_decoded_bytes` produces a `compression: "unsupported"` inventory with one
diagnostic and no records, rather than a silent empty result.

## Diagnostics

Each diagnostic carries the ordinal of the record that produced it (or `null`
for an archive-wide fact) and a stable code:

| code                            | meaning                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `not-a-warc-stream`             | the decoded bytes do not begin a WARC record                          |
| `truncated-record`              | the header block or the declared payload is incomplete                |
| `unsupported-compression`       | the gzip member could not be decoded                                  |
| `invalid-header-line`           | a header line is not a single field                                   |
| `invalid-content-length`        | the record has no usable `Content-Length`                             |
| `record-limit-reached`          | inventory stopped at `max_records`                                    |
| `decoded-size-limit-reached`    | decompression would exceed `max_decoded_bytes`                        |
| `trailing-bytes`                | bytes between or after records are not a WARC record                  |
| `header-line-limit-reached`     | a header line exceeds 8 KiB                                           |
| `header-block-limit-reached`    | a header exceeds 1 MiB or 20000 retained fields and malformed lines   |
| `diagnostic-limit-reached`      | further diagnostics were omitted after 10000                          |
| `invalid-version-limit-reached` | inventory stopped after 10000 version lines with no parseable version |

A record whose header block cannot be read ends the scan, because the next
record's offset cannot be established without inventing one. Records read before
that point are still reported and counted.

## Resource bounds

| input               | default | maximum |
| ------------------- | ------- | ------- |
| `max_file_bytes`    | 64 MiB  | 64 MiB  |
| `max_decoded_bytes` | 256 MiB | 256 MiB |
| `max_records`       | 20000   | 20000   |

These are resource allowances, not WARC or HTTP format limits. The decoded
stream is bounded during inflation, and each record header is bounded before
fields and diagnostics are collected. A header exceeding 8 KiB per line,
1 MiB total, or 20000 retained fields and malformed lines stops the scan with partial coverage. An archive that expands past
`max_decoded_bytes` is reported instead of exhausting memory.

## Identity

`archive_id` derives from the selected file's SHA-256 and byte length.
`record_id` derives from the record's offset in the decoded stream, its ordinal,
its type and its `WARC-Record-ID`, so the identifier is stable across runs of the
same bytes and distinct for repeated records at different offsets.
