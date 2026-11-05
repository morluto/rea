# Read a captured application's state

## Outcome

`rea inspect-desktop-application-state <capture-folder>` turns a capture
folder into the application's state: every retained or changed file with a
role, a typed JSON view of each version and the kinds of change between
versions. Export reads this to choose the seed and the data paths; task
generation reads the kinds of change.

## Requirements

- CLI only, like the capture. The folder's `capture.json` must be
  `capture_desktop_application` Evidence from provider `rea-desktop` v1 with a
  valid result; anything else is refused as invalid input.
- Retained bytes are read without following links and used only when their
  SHA-256 matches the name they are stored under.
- Each path gets the reasons the capture supports (state directory, open file,
  window title, selected path, dconf application keys, shared desktop
  location) and one role derived from them.
- Each version is the baseline or the file after a checkpoint that changed it.
  Formats: SQLite through REA's worker on a private copy with any retained
  `-wal` or `-journal` beside it (a hot journal is refused by the worker),
  refused when either existed but was not retained or the capture did not
  record whether it existed (unknown is never read as absent; absence holds
  only under content roots the baseline walked completely, with no truncation,
  unreadable directory or unchecked path, outside recorded exclusions); dconf through
  `dconf dump /` on a private file profile, keeping only
  groups whose path names the application; JSON up to 4 MiB and 500 levels
  with exact numbers; XML through the shared strict parser with DOCTYPEs
  refused; key files up to 4 MiB whose every line parses; zip archives by
  their local file header, as their entries with each entry's own format and
  view ([document views](../document-views/spec.md)); text; binary.
- Changes between versions are created, deleted, or lines, values, keys or
  rows with added, removed and changed lists (100 each, with counts); content
  for binary files and unreadable when a view is missing. Values are JSON
  pointers to every value, containers included, compared on one shared path
  so memory follows depth, and a pointer over 4096 characters is counted but
  not listed; keys are `group/key` with the key escaped as a JSON pointer
  segment, so distinct entries never share a name. Zip values name array
  members by selector where one names a member in both versions.
- The Evidence has operation `inspect_desktop_application_state`, predicate
  type `rea.desktop-application-state` and confidence `inferred`.

## Non-goals

- No export, seed selection or task generation.
- No parsing of other binary formats (GVDB other than dconf, LevelDB, Realm,
  protobuf); they are listed as binary.
- No redaction: views contain the user's real data, as the capture does.
