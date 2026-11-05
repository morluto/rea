# Verification

Run on 2026-11-05 on top of the vendor .deb files branch, on macOS with Node
v22.23.1 and Python 3.11.14.

## Gates

- `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `knip` (after
  `build:cached`), `jscpd`, `docs:check`, `docs:build`,
  `verify:test-discovery` and `verify:architecture-guards`: passed, with no
  lint or typed-lint diagnostics in the touched files. The one clone jscpd
  lists in a touched file, `DesktopApplicationState.ts` against
  `GpgvKeyCheck.ts`, was there before.
- `npx vitest run src/domain/desktop src/application/desktop src/desktop` with
  `tests/boundary/providers/desktopExportPython.test.ts`,
  `desktopTaskPython.test.ts` and `tests/boundary/cli/cliStartupImports.test.ts`:
  365 passed and 18 skipped (Linux-only cases). The new
  `tests/boundary/providers/desktopZipPython.test.ts`: 8 passed. The desktop
  CLI boundary tests `desktopApplicationCli`, `cliInputSchemaRequired` and
  `cliToolCoverage`: 28 passed.

## Tests

Each new test fails on the code before this change, run from a copy of that
commit with only the new tests and fixtures added; the tests already in the
touched files still pass there.

- Parity of the two zip readers, REA's and the exported module's, on the same
  archives: entries in order with JSON, key file, XML, text, UTF-8-named and
  binary entries, a directory left out, and an archive, a SQLite database and
  an inexact JSON number inside, each not read for its reason; an encrypted
  entry, bzip2, a declared 17 MiB entry, a 943-times expansion, a bad CRC-32
  and a short declared size; a damaged archive; 1,002 entries; and the 64 MiB
  archive budget through both readers' refusal functions.
- FreeCAD: the real `Document.xml` of FreeCAD 0.21 and 1.0, before and after
  the hole, zipped into `.FCStd` archives. Both readers give the same views,
  and both evaluators give the same results and descriptions: a `Part::Cut`
  exists, the `Hole` radius is 5 ± 0.01 and the cut's tool links `Hole` all
  fail before the edit and pass after it, in both versions, by the same
  pointers.
- OpenDocument: an `.odt` built in the test reads as `mimetype` text and
  `content.xml` and `META-INF/manifest.xml` as XML, with the paragraph's text
  in the view; the readers agree but for the namespaced XML names, and the
  export refuses a check into `content.xml` for its namespaces.
- Selectors and tolerance in the shared check cases both evaluators run: one
  member matched, several, none before or at the last segment, a malformed
  selector, an escaped `/` in an entry name, an entry by index, a selector
  over strings in an array, per-entry truncation, an entry the listing left
  out; numbers and numeral strings within a tolerance, outside it, a string
  and a boolean that are not numbers, and `tolerance: 0`.
- `locatePointer` and the member keys: the most general selector unique among
  siblings, passed over when it names several members of the other version,
  and values that hold `][` or look like a time left out.
- The keyed zip diff: an object inserted before another shifts nothing, and a
  comparison is incomplete when an entry is unread, truncated or not listed.
- The draft: an archive's added and removed elements and changed values by
  selector, nothing inside namespaced XML; and through the application, a
  capture with a FreeCAD document and an `.odt` whose draft the export then
  accepts.

## Review fixes

Each fix has a regression test that fails on the reviewed commit and passes
after it:

- A selector over an array a view may hold only part of is undecided in both
  evaluators: a truncated XML view, a cut listing searched by entry name, and
  a truncated entry's XML, beside positions into the same views that stay
  decided.
- The zip diff pairs members one to one: an element whose attributes split
  across two new siblings leaves one paired and the other added.
- The draft checks an entry or a JSON value added whole through its members,
  and suggests nothing that reaches an element by position, the last step
  included.
- The export refuses a check on the whole listing whose value holds
  namespaced XML.
- The exported reader keeps a JSON entry nested 1,100 deep on that entry,
  with its siblings read, and refuses JSON nested more than 500 levels as REA
  does, 501 levels read and 502 refused, in a file or an entry.
- The exported reader reports an entry damaged when its declared size is
  short and its checksum is the prefix's, deflated or stored, as REA does.

## FreeCAD captures

The real `.FCStd` files the FreeCAD investigation captured, from FreeCAD 0.21
(Ubuntu 24.04 with the FreeCAD PPA) and 1.0 (Ubuntu 25.10), read by the built
CLI:

- `inspect-desktop-application-state`: `plate.FCStd` is `zip` in every
  version, 2 entries before and 15 or 16 after, with a complete `values`
  change listing `/entries/[name=Document.xml]/view/root/children/[name=Objects]/children/[name=Object][@name=Hole]`
  among the added values; the `.FCBak` backups are `zip` too.
- REA's evaluator and the exported module's, each on its own view of the
  retained bytes: identical views, and the hole task's two checks fail before
  and pass after in both versions.
- `export-desktop-application --task` on the 0.21 capture keeps the task with
  both checks failing on the seed and writes the selectors and the tolerance
  into `verify.py`. The 1.0 capture is not exported, as before this change:
  its package installs only on Ubuntu 25.10.
- `describe-desktop-application-task` on the 0.21 capture drafts ten checks on
  `plate.FCStd`, all by selector (the six objects and dependencies FreeCAD
  added, then counts and statuses), and the export keeps that draft with all
  ten failing on the seed.
