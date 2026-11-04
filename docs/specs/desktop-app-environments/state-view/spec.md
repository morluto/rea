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
  `-wal` beside it; dconf through `dconf dump /` on a private file profile,
  keeping only groups whose path names the application; JSON; XML through the
  shared strict parser with DOCTYPEs refused; key files; text; binary.
- Changes between versions are created, deleted, or lines, values, keys or
  rows with added, removed and changed lists (100 each, with counts); content
  for binary files and unreadable when a view is missing.
- The Evidence has operation `inspect_desktop_application_state`, predicate
  type `rea.desktop-application-state` and confidence `inferred`.

## Non-goals

- No export, seed selection or task generation.
- No parsing of other binary formats (GVDB other than dconf, LevelDB, Realm,
  protobuf); they are listed as binary.
- No redaction: views contain the user's real data, as the capture does.
