# Verification

Run on 2026-11-05 on top of the vendor .deb files branch, on macOS with Node
v22.23.1 and Python 3.11.14.

## Gates

- `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `knip` (after
  `build:cached`), `jscpd`, `docs:check`, `docs:build`,
  `verify:test-discovery` and `verify:architecture-guards`: passed, with no
  lint or typed-lint diagnostics in the touched files. The one clone jscpd
  lists in a touched file, `DesktopApplicationState.ts` against
  `GpgvKeyCheck.ts`, was there before. After main was merged in, `lint` and
  `lint:typed` fail only on main's own `tests/acceptance/webSourceLocationCli.test.ts`.
- `npx vitest run src/domain/desktop src/application/desktop src/desktop` with
  `tests/boundary/providers/desktopExportPython.test.ts`,
  `desktopTaskPython.test.ts` and `tests/boundary/cli/cliStartupImports.test.ts`:
  374 passed and 18 skipped (Linux-only cases). The new
  `tests/boundary/providers/desktopZipPython.test.ts`: 9 passed, and
  `desktopJsonDepthHeap.test.ts`: 1 passed. The desktop
  CLI boundary tests `desktopApplicationCli`, `cliInputSchemaRequired` and
  `cliToolCoverage`: 28 passed.
- Namespaced XML, on the same day and toolchain: the same gates passed, with
  no lint, typed-lint or jscpd findings in the touched files, and the desktop
  tests with the four provider parity files, `desktopXmlPython.test.ts` among
  them: 370 passed and 18 skipped.

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
  in the view; the readers give the same view, namespaced names included, and
  the export keeps a check of the paragraph by `[name=text:p]`.
- Namespaced XML, in `desktopXmlPython.test.ts`: the real saves of an
  Inkscape 1.2.2 poster and a LibreOffice 24.2 Writer flyer, before and after
  one edit, read alike by both readers, the SVG as a file and `content.xml`
  in an `.odt` built in the test. Both evaluators give the same results and
  descriptions: the headline `[name=text][@id=headline]` under the layer
  `[@inkscape:label=Layer 1]` and the `[@text:style-name=Subtitle]` date fail
  before the edit and pass after it, and `inkscape:document-units` passes in
  both. Built documents cover `xmlns` declarations in document order, an
  undeclared default namespace, `xml:` attributes, CDATA, comments and
  processing instructions, what both parsers refuse (an undeclared prefix,
  one attribute twice under two prefixes, a prefix bound to `""`, two colons
  in a name, a colon in a processing instruction's target, a DOCTYPE),
  and the node and depth limits on prefixed names.
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
  selector, inside namespaced XML too, where a paragraph is named by
  `[name=text:p][@text:style-name=Subtitle]`; and through the application, a
  capture with a FreeCAD document and an `.odt` whose draft, with a check of
  the list's paragraph, the export then accepts.

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
- The export accepts a check on the whole listing whose value holds
  namespaced XML, since both readers name it alike.
- The exported reader keeps a JSON entry nested 1,100 deep on that entry,
  with its siblings read, and refuses JSON nested more than 500 levels as REA
  does, 501 levels read and 502 refused, in a file or an entry.
- The exported reader reports an entry damaged when its declared size is
  short and its checksum is the prefix's, deflated or stored, as REA does.
- An array that becomes an object with the same keys, or the reverse, is a
  changed value, with nothing in it added or removed, so the draft suggests no
  absence the end state contradicts.
- The draft checks an empty array or object added to a JSON entry as it is.
- An entry REA could not read, whose `view` is therefore `null`, gets no
  drafted check, and both evaluators fail `value_equals null` into its view,
  while a JSON entry holding `null` still passes it.
- The exported reader's depth check holds one iterator per level: on a
  4,000,001-byte array of 800,000 nulls, `_text_view` peaks at 6.7 MB of
  traced allocations, as before the check, against 58.2 MB when it queued
  every member.
- A binary entry fails `value_equals null` and `value_absent` into its view in
  both evaluators, its `size` still checked, and the draft suggests no absence
  in an entry that ends binary.
- REA's own depth check (`deeperThan`, from the state view) also holds one
  iterator per level: on 800,000 nulls it grows the heap by 7.3 MB of
  short-lived iterator results, against 72.7 MB when it queued a pair per
  member, and runs under an 18 MiB old-space limit where the queue needed more
  than 64 MiB. A test runs it under a 32 MiB limit.
- The exported reader reads an entry in 64 KiB chunks up to a byte past its
  declared size: a 32,731-byte archive holding 32 MiB of zeros declared as one
  byte peaks at 0.1 MiB of traced allocations, against 77.5 MiB when it read
  the stream whole before clipping it, both reporting the entry damaged as REA
  does. An 8.7 MiB text entry peaks at 48.5 MiB against 47.6 MiB. REA's zip.js
  reader already stops at the first chunk past the declared size: reading that
  archive grows the peak resident size by 0.8 MiB, as a one-byte archive does.
- A check of a namespaced entry's `size`, of its absence, or comparing the
  entry whole exports, since both readers name namespaced XML alike.
- The diff finds a counterpart by the evaluator's own step: a bracketed key
  against an array is a selector, so `{"[name=x]": 1}` becoming
  `[{"name": "x"}]` reports nothing removed, in an archive or a JSON file, and
  the draft suggests no absence of a value the selector still names.

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
