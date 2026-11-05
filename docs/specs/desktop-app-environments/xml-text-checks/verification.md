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
