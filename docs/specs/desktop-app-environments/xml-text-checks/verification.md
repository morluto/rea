# Verification

Run on 2026-11-05 on top of the namespaced XML views branch, on macOS with
Node v22.23.1 and Python 3.11.14 (expat 2.7.4).

## Gates

- `npm run typecheck`, `format:check`, `build:cached` then `knip`, `jscpd`,
  `docs:check`, `docs:build`, `verify:test-discovery`,
  `verify:architecture-guards` and `verify:module-boundaries`: passed.
  `lint` and `lint:typed` on the touched source and test files: no
  diagnostics; jscpd lists no clone in a touched file.
- `npx vitest run src/domain/desktop src/application/desktop src/desktop
  src/domain/xmlDocument.test.ts` with the eight `tests/boundary/providers/desktop*`
  files and the CLI boundary tests `cliStartupImports`,
  `desktopApplicationCli`, `cliInputSchemaRequired` and `cliToolCoverage`:
  492 passed and 18 skipped (Linux-only cases).
- The parity files `desktopXmlTextPython`, `desktopXmlPython`,
  `desktopTaskPython`, `desktopZipPython` and `desktopExportPython`: 34 passed
  under each of Python 3.9.6 (expat 2.2.8), 3.10, 3.11, 3.12, 3.13 and 3.14.

## Tests

Each new test fails on the code before this change, run from an export of
that commit with only the new tests, fixtures and test support added: 31
failed and the 112 tests already there passed.

- AbiWord, in `desktopXmlTextPython.test.ts`: a synthetic `.abw` in the form
  AbiWord 3.0 saves, with its AWML DOCTYPE, before and after the meeting time
  changed to `3:30`, which the edit split into `c` runs. Both readers give the
  same `xml` view with the same `doctype`; before this change it was text.
  Both evaluators give the same results and descriptions: `text_equals` and
  `text_contains` on `[name=p][@xid=3]` fail before the edit and pass after
  it, while `value_equals` on its `children/0` fails after it too.
- Writer runs: a Writer `content.xml` derived from the real 24.2 save, its body
  paragraph split into `T1` spans with a bare space between two of them,
  zipped into an `.odt`. Both readers give the same view, the space kept as
  mixed content; `text_equals`, `text_contains` with `normalize_whitespace`
  and a reflowed `text_equals` fail before and pass after in both evaluators,
  and `children/0` does not pass.
- DOCTYPE: built documents both readers read alike (a name only, `SYSTEM`
  with `[` in its literal, `PUBLIC` with whitespace to normalize, empty
  literals, a prefixed name, a name that differs from the root's) and refuse
  alike (an empty internal subset, entity declarations with and without a
  reference, an external general entity, a parameter entity, an undeclared
  entity in content and in an attribute value with an external DTD, a
  `PUBLIC` without a system literal, an illegal public identifier character,
  a DOCTYPE after the root, two DOCTYPEs). A DTD written to disk and named by
  its `file:` URL is not read: its entity stays undeclared and its default
  attribute absent, in both readers.
- Whitespace: mixed content keeps the space between runs and element content
  drops formatting, in both readers; a no-break space, U+0085 and U+FEFF
  between elements are kept as text in both. Before, both dropped the
  no-break space, REA also U+FEFF and the exported module U+0085, so the two
  disagreed on those.
- Shared check cases both evaluators run: the whole text of a split
  paragraph, with nested elements, empty, a text node, an attribute value,
  exact and collapsed, equal and contained; an absent file, JSON and text
  files, a non-element value, a selector matching nothing, an element of a
  truncated view and a selector over it (undecided) beside a text node there
  (decided), an archive's XML entry, its JSON entry, its binary entry, a
  pointer to an entry's name, and a truncated entry.
- Parser: the `external` policy reads a DOCTYPE without an internal subset and
  refuses one with it, `]` in a literal included, and `declaredDocumentType`
  reports the identifiers unquoted, the public one normalized.
- Task file: the empty pointer, a pointer without `/`, an empty or
  whitespace-only `text_contains` value, a time-like value and a non-boolean
  `normalize_whitespace` are refused; the export refuses a text check into a
  text file.
- Draft: an element's whole text by selector in an SVG, in an archive's
  namespaced XML and in the AbiWord note, with nothing suggested inside the
  paragraph, and no text check where only whitespace text changed; through
  the application, a capture whose `.odt` paragraph an edit split into runs
  drafts `text_equals` on it, and the export keeps a task with it, failing on
  the seed, while `value_equals` on its first run fails at the end.

## Review fixes

Run on 2026-11-05 with the same toolchain. Each fix has tests that fail on the
reviewed commit, run from an export of it with only the changed tests and
fixtures added (8 failed, 64 passed), and pass after it. The gates above pass
again: lint and typed lint report nothing in the touched files, and the
desktop set gives 497 passed and 18 skipped, the parity files 34 under each
of Python 3.9 to 3.14.

- A drafted text check names the paragraph, not a run. A changed value is read
  at both ends, so text an app wraps in a run (`<p>old</p>` becoming
  `<p><c>new</c></p>`) still marks its paragraph; the check goes up from an
  element in mixed content, and from one named by its tag or position alone
  to the nearest ancestor named by an attribute, as AbiWord's `p` by `xid`. Edits
  that replace text with a run, change the text of a paragraph's only run, or
  of a run among the paragraph's own text all draft `text_equals` on
  `[name=p][@xid=6]`, which passes on the edited save and on one splitting the
  text into other runs; in an archive, text turned into two spans drafts the
  `text:p`. A link whose label and `href` both change drafts the paragraph's
  text and keeps `value_equals` on the new `href`.
- Text checks read only an element, a text node or an attribute's value: an
  element's `name` and the `doctype`'s fields fail in both evaluators, in a
  file or an archive entry, while an attribute's value in an entry passes.
- The tests of text checks assert outcomes and the facts in a description (the
  pointer, the text found, the value compared) rather than its wording.
  Rewording the descriptions in both evaluators passes them; showing the value
  uncollapsed fails them.
- The draft leaves out times in C's `asctime` form, as AbiWord stamps
  `abiword.date_last_changed`, which the task parser also refuses, and drafts
  an XML file as an archive's entries are: by selector, never through an
  element by position, and without whitespace text between elements. For the
  AbiWord note it suggests the paragraph's text first and no save time;
  `history`'s `version`, `edit-time` and `last-saved` remain, named.

## Second review fixes

Run on 2026-11-05 with the same toolchain. The new draft tests fail on the
reviewed commit, run with only the changed test file (6 failed, 23 passed),
and pass after it. `npm run typecheck`, `docs:check`, and lint and format on
the touched files pass; the desktop set (`src/domain/desktop`,
`src/domain/xmlDocument.test.ts` and the `tests/boundary/providers/desktop*`
files) gives 329 passed, and `src/application/desktop` with `src/desktop`
141 passed and 18 skipped. The drafts for the Inkscape, AbiWord, Writer and
FreeCAD fixtures are the same as on the reviewed commit.

- A run added or removed whole marks its paragraph, the nearest ancestor both
  ends hold, by the text anywhere in it. `Meeting at ` gaining
  `<c>3:30</c>` drafts `text_equals` `Meeting at 3:30` on `[name=p][@xid=6]`
  and no check that the run is there: a save splitting the text into other
  runs passes it and `13:30` in the run fails it. So does a bold run added to
  a paragraph made only of runs, though its `props` name it. Removing a run
  drafts the paragraph's remaining text instead of the run's absence.
  `<p>Hello</p>` gaining `<span> world</span>`, or ` world` in a `b` inside
  the span, drafts `Hello world` on the paragraph, in a body and as the
  document's root, which `WRONG` in the span fails.
- A new paragraph `p[@xid=7]` drafts its section's text where the section is
  short enough to check, and its own text where it is not, instead of a check
  that it is there; other words in it and the seed fail both.
- An element the diff names by its tag alone, and an identifier of its own
  names, takes the check ahead of the ancestor named by another attribute: an
  SVG headline, the only `text` in a layer, drafts `text_equals` on
  `[name=text][@id=headline]` rather than the layer, the `text`'s `id` chosen
  over its `tspan`'s, and Inkscape's own save keeps its check on the
  `text`, which the diff already names by its `id`. Another attribute names
  it only where the layer cannot take the check: with only `xml:space`, the
  check stays on a short layer, and on the `text` by `xml:space` past 2,000
  characters, where it had fallen back to `value_equals` on the `tspan`'s
  first text node. A save splitting the headline across two `tspan`s passes
  it and the old headline fails it. When the edit also changed the `id`, no
  text check is drafted.

## Third review fixes

Run on 2026-11-06 with the same toolchain. Each new case fails on the
reviewed commit and passes after it. The desktop set gives 873 passed, with
only `desktopExportSqliteMetadata.test.ts` failing, as it does on `main` in
this environment; the XML parity files give 16 passed under each of Python 3.9
to 3.14. The drafts for the Inkscape, AbiWord, Writer and FreeCAD fixtures,
as files and as archive entries, are the same as on the reviewed commit.

- A paragraph's text check no longer stands in for an element holding no text
  that an edit adds or removes in it. In an archive, `Hello` becoming
  `Hello there` with a `draw:frame` holding an image drafts the paragraph's
  text and the frame's presence, and the frame removed drafts its absence; in
  an AbiWord paragraph, an `image` added or a `br` removed beside the text
  edit does the same. A save with the new text alone fails the presence or
  absence check, and a run holding text added in the same edit still gets no
  check of its own.
- The exported module reports a DOCTYPE's system identifier with each line
  ending a line feed, as REA's parser does: `"x\r\ny\rz\n"` reads as
  `x\ny\nz\n` in both, where `expat` had passed it as written.
