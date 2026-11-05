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
- Parsed views: a JSON or key file entry or file over the 4 MiB limit is
  refused before its value is built, in both readers. Its format is told
  apart from text by a token scan that builds no value and holds a byte per
  open container, which the exported reader also uses when Python's parser
  reaches its recursion limit, so deeply nested text is JSON only when all of
  it is.
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
  listing truncated when the entry is not listed. A pointer whose selector
  searches an array the view may hold only part of (any array of a truncated
  XML view or entry view, or a cut listing) fails as undecided in both
  evaluators. A check into the view of an entry without one (binary, or with a
  `view_error`) fails in both evaluators, while checks on its metadata read;
  the draft checks only entries with a view, and an absence only where the
  entry still has one.
- Changes: `values` between zip versions pair array members one to one, by
  the first selector naming a member alone in its version and one unpaired
  member of the other (entries by name, XML elements by tag and attribute),
  even when a selector before it names nothing there, then by position; a
  member left unpaired is keyed by a selector naming it alone and nothing in
  the other version. Identity comes first: an element with identifying
  attributes (`name`, `id`, `xid`, or a prefixed `id` such as `xml:id`) is
  selected by its tag and those alone, so one whose identifiers name nothing
  in the other version is added or removed; its other attributes (`type`,
  `color`) are tried only for elements without one. Selectors are spelled
  only once chosen, so a long tag is not copied per attribute. A comparison
  is incomplete when either view leaves something out.
- Draft: for a zip document, checks inside its entries' JSON, key file and
  namespace-free XML views, through no object or array by position and no
  array a view may cut: an element added whole exists, one removed whole is
  absent, then values changed, added and removed, with an entry or a JSON value
  added whole checked through its members.
- Export refusals: a pointer into an archive entry's XML that uses namespaces,
  or a `value_equals` whose value holds such an entry whole, as an entry or the
  whole listing does, while its metadata and its absence export; and a
  `tolerance` whose value is not a number.
- Reading: the exported reader reads an entry in bounded chunks, at most one
  byte past its declared size, so a forged small size cannot make it expand
  the rest of the stream.
- Directory: both readers read the central directory themselves, a record at a
  time through the Zip64 end record whenever a Zip64 locator precedes the end
  record, whatever the end record holds, count the file entries (directories told
  apart as zip.js does: a final slash, a Unix directory mode, or the MS-DOS
  attribute), and give zip.js or `zipfile` only the first 1,000 records, so
  memory does not grow with the number of entries.

## Non-goals

- No reading of an archive inside an archive, or of a database inside one.
- No namespace parity: the exported module still spells namespaced XML names
  as `{namespace}local`, so checks into OpenDocument or Office Open XML
  content are refused.
- No other compression methods (bzip2, LZMA, Zstandard) and no encrypted
  entries.
- No selectors over non-string values, nested fields other than `attributes`,
  or values holding `][`.
