# List the records of a local WARC archive offline

Issue: https://github.com/morluto/rea/issues/9175

## Problem

Web-archive captures are a common forensic input, but REA had no way to list
what a saved WARC or WARC.gz holds without a replay tool that would fetch the
target URLs again. An analyst could not state which records the file contains,
what each embedded HTTP message was, or what the file does and does not
establish.

## Desired behavior

`inspect_warc_archive` (MCP) and `rea inspect-warc-archive` (CLI) read one local
WARC or WARC.gz file and return retained Evidence listing its records in archive
order. Nothing is fetched or replayed: no target URI is contacted, no request is
resent, no archived content is executed and no file outside the selection is
read.

## Requirements

- Each record keeps its version line, `WARC-Type`, `WARC-Date`,
  `WARC-Record-ID`, `WARC-Target-URI`, `Content-Type`, the declared
  `Content-Length`, the block and payload digests, `WARC-IP-Address`,
  `WARC-Profile`, `WARC-Segment-Number` and the byte extent it occupies.
- A `request` or `response` record also carries its embedded HTTP start line and
  header block, with field order and repeats preserved. Authentication and
  cookie values are withheld; user information in URL-valued fields is redacted.
- A payload that starts like an HTTP message but cannot be represented is
  omitted with a named reason in `http_omitted` and a diagnostic, so an omitted
  message never reads as an ordinary non-HTTP body. The reasons are the start
  line and header-block ceilings, a malformed start line, an unterminated start
  line, an unterminated header block and the archive-wide header allowance.
- Each ceiling is a reader allowance rather than an HTTP limit; hitting one on an
  intact archive says so.
- An unknown `WARC-Type` stays listed with `record_type_known: false` instead of
  being dropped.
- Declared digests are reported as written and are not verified. Records are not
  linked by `WARC-Record-ID` or payload digest, and a `revisit` record is not
  resolved to the response it refers to.

## Limits

The archive is decoded once, gzip magic is the only supported compression, and
the decoded size, record count, header line, header block and archive-wide
header entry allowances each report a diagnostic instead of silently truncating.

## Acceptance

- A capture yields every record in archive order, and each parsed `request` and
  `response` carries its start line and headers.
- An inverted state — an unterminated start line, an unterminated header block,
  an over-ceiling line, an unknown record type or a truncated record — keeps the
  facts it did establish and names the rest in `http_omitted` and `diagnostics`.
- An absent record never proves that a capture did not contain it.

## Non-goals

Contacting a target URI, replaying a request, decoding an HTTP body, content
coding or trailers, verifying declared digests, resolving `revisit` records, and
reconstructing a browsing session across records.
