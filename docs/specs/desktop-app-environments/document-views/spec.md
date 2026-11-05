# Documents saved as zip archives

## Outcome

A document an application saves as a zip archive, first FreeCAD's `.FCStd`,
is read into a view of its entries, so a task can check what the user did in
it. Checks name the XML elements they read by tag and attribute rather than by
position, so the same check holds across application versions that write the
document in another order, and compare numbers written as text within a
tolerance. Both evaluators, REA's and the exported verifier's, agree.

## Requirements

- Format: a file starting with a zip local file header (`PK\x03\x04`) is
  `zip`, whatever its name. Its view is
  `{entries, entry_count, truncated}`: the file entries in archive order,
  directories left out, each `{name, size, sha256, format, view, view_error}`.
- Reading: from the retained bytes already checked against their digest, in
  memory, with REA's zip reader options (CRC-32 and overlap checks, CP437 or
  UTF-8 names); nothing is extracted. Each entry's format and view come from
  the state view's own readers and limits, with the entry name in place of the
  file name. A SQLite or dconf database, or an archive, inside an archive is
  not read and says so.
- Limits: at most 1,000 entries listed (`entry_count` counts all); an entry is
  read only when it is unencrypted, stored or deflated, at most 16 MiB
  uncompressed and at most 100 times its compressed size, and while the
  archive has read at most 64 MiB. An entry over a limit, or whose data fails
  its checks, has `sha256`, `format` and `view` null and a `view_error`.
- Exported module: `data/get` gives the same view, read with Python's
  `zipfile` from the file in place with the same limits, order of checks and
  wording; parity tests compare the two readers on the same archives.
- Selectors: on an array, a pointer segment `[KEY=VALUE]` names the member
  whose string field `KEY` is `VALUE`, `[@KEY=VALUE]` the member whose
  `attributes` hold it, and conditions can follow one another. A selector must
  match exactly one member; several, or none before the last segment, fail the
  check with a message naming the selector. None at the last segment names no
  value, so `value_absent` passes and `value_equals` fails.
- Tolerance: `value_equals` takes an optional non-negative `tolerance`, with a
  number `value`, and passes when the value found is a number, or a decimal
  numeral string, at most `tolerance` from it.
- Truncation: a check decided by what a zip view leaves out depends on the
  entry its pointer goes into: that entry's view missing or truncated, or the
  listing truncated when the entry is not listed.
- Changes: `values` between zip versions name array members by the first
  selector naming one member in each version, entries by name and XML
  elements by tag and attribute, and fall back to positions; a comparison is
  incomplete when either view leaves something out.
- Draft: for a zip document, checks inside its entries' JSON, key file and
  namespace-free XML views, through no element by position: an element added
  whole exists, one removed whole is absent, then values changed, added and
  removed.
- Export refusals: a pointer into an archive entry's XML that uses namespaces,
  and a `tolerance` whose value is not a number.

## Non-goals

- No reading of an archive inside an archive, or of a database inside one.
- No namespace parity: the exported module still spells namespaced XML names
  as `{namespace}local`, so checks into OpenDocument or Office Open XML
  content are refused.
- No other compression methods (bzip2, LZMA, Zstandard) and no encrypted
  entries.
- No selectors over non-string values, nested fields other than `attributes`,
  or values holding `][`.
