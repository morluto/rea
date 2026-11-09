# Verification

Run on 2026-11-04 on top of the capture branch (`def249ef5`): gates and source
tests on macOS 26.5 with Node v22.23.1; the end-to-end runs in an Ubuntu
24.04.5 arm64 container with Node v24.22.1, Xvfb, xfwm4, Mousepad 0.6.1,
`dconf-cli` and `sqlite3`.

## Gates

- `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `knip`, `jscpd`,
  `docs:check`, `mcp-catalog:check`, `verify:test-discovery`,
  `verify:architecture-guards` and `scan:todos`: passed, with no lint
  diagnostics in the new source files.
- New domain and service tests: format detection and views, kinds of change
  for every format (including SQLite rows with and without a primary key),
  roles and dconf group matching, and the service on a synthetic capture folder
  with fake readers, plus refusal of Evidence from another operation.
- CLI boundary: tool coverage, startup imports and required input schemas
  passed (30 tests).

## Mousepad end to end

A fresh Mousepad capture (type a line, save `~/Documents/groceries.txt`, stop)
was read with `inspect-desktop-application-state`:

- `Documents/groceries.txt`: `document` (named in a window title), text view
  `["Groceries: milk, eggs, coffee"]`, created between the baseline and
  `saved`.
- `.config/Mousepad/accels.scm`: `application_state` (state directory), text.
- `.config/dconf/user`: `application_state` through Mousepad's own dconf
  groups, read with `dconf dump`. The `saved` view holds
  `org/xfce/mousepad/state/application` with the session naming
  `groceries.txt`, and lists the GTK file chooser group separately. Its
  `typed` version has no view: dconf replaced the file between the walk and
  the read, so the capture left it out as changed since the walk.
- The window manager's xfconf files and GTK's `recently-used.xbel` are
  `shared_desktop`; the xbel change lists the `modified` attributes it touched.

## SQLite end to end

A script captured with `--executable notesapp` inserted a row and updated
another in `~/.local/share/notesapp/notes.db`, then deleted the first, with a
checkpoint after each step. Read through REA's SQLite worker, the database is
`application_state`, and its changes are `rows`: `notes:[2]` added and
`notes:[1]` changed, then `notes:[1]` removed.

## Limits of this verification

- Only Mousepad and a script application were captured; JSON and key-file
  state come from unit tests.
- A database in WAL mode with a retained `-wal` file was not exercised end to
  end.
