# XML with a DOCTYPE, and whole-text checks

## Outcome

A document saved as XML that begins with a DOCTYPE naming its DTD, first
AbiWord's `.abw`, is read as XML rather than text, so a task can check what
the user wrote in it. A check can compare an element's whole text, so it holds
however an app splits a paragraph into runs as it saves: AbiWord's `c`
elements, Writer's `text:span`. Both evaluators, REA's and the exported
verifier's, agree.

## Requirements

- DOCTYPE: one with a name and, optionally, a `PUBLIC` or `SYSTEM` external
  identifier is read as XML by both readers. The DTD it names is never fetched
  or read. One with an internal subset (`[ … ]`), even an empty one, is
  refused, so a document can declare no entity, and a reference to any entity
  but XML's five (`amp`, `lt`, `gt`, `apos`, `quot`) is refused, in content
  or in an attribute value, though the DTD a DOCTYPE names might declare it.
  A refused document is no XML view, so the file reads as text, as a malformed
  one does, in both readers.
- View: the element tree is the one the document has without its DOCTYPE,
  within REA's node and depth limits; the declaration is no node. The view
  records it beside `root` as
  `doctype: {name, public_id, system_id}`, an identifier `null` when the
  DOCTYPE gives none, the public one normalized as XML matches it: each run
  of spaces and line breaks one space, the ends trimmed. The system one keeps
  its spaces, each line ending a line feed as XML reads the document, which
  the exported module does itself since `expat` passes the literal as
  written. A document without a DOCTYPE has no `doctype`.
- Exported module: `expat` with parameter entity parsing off, and handlers
  that refuse an internal subset, an external entity and a skipped entity. The
  pass with namespace processing also checks each start tag for a reference
  to an undeclared entity, which `expat` drops from an attribute value without
  calling a handler when a DOCTYPE names a DTD.
- Whitespace in the view: whitespace-only text between child elements is
  formatting, and dropped, only in an element that holds no other text,
  outside `xml:space="preserve"`; in mixed content, an element holding text
  beside its children, it is kept, so the space between two runs is part of
  the text. Whitespace is XML's: space, tab, carriage return and line feed. A
  no-break space and other Unicode spaces are text, in both readers alike.
- Checks: `text_equals` and `text_contains`,
  `{id, kind, file, pointer, value, normalize_whitespace?}`. The pointer, with
  selectors as for `value_equals`, names an element of an XML view, in a file
  or an archive entry's `view`, or a text node or attribute value in one. An
  element's text is XPath's `string()` of what the view keeps: every text node
  in it and its descendants, CDATA included, in document order; a text node's
  or an attribute's is its value. `text_equals` passes when that text equals
  `value`, `text_contains` when it holds `value`, exactly, case and all.
  `normalize_whitespace: true` collapses each run of XML whitespace in both
  the text and `value` to one space and trims their ends before comparing, as
  `normalize-space()` does.
- Failures, worded alike in both evaluators: an absent file; a file of another
  format; a pointer into an archive outside an entry's `view`, or into an
  entry of another format; a value that is neither an element, a text node
  (a string among an element's `children`) nor an attribute's value (one among
  its `attributes`), so an element's `name` and the `doctype`'s fields fail;
  and, as undecided, in a view that leaves something out, either check of an
  element, even one whose kept text holds the value, since the cut may have
  dropped text from between the runs it kept; a pointer naming nothing; or a
  selector searching an array such a view may cut. A text node or an
  attribute's value is whole, so it is decided on a truncated view.
- Refusals: the task parser refuses the empty pointer, a pointer not starting
  with `/`, an empty `text_contains` value or one that is only whitespace
  with `normalize_whitespace`, and a value that looks like a date and time,
  in ISO 8601 or C's `asctime` form (`Www Mmm dd hh:mm:ss yyyy`, as AbiWord
  stamps a save); the export refuses a text check into a file read as text.
- Draft: an XML file is drafted as an archive's entries are, from the keyed
  diff that names members by selector: never through an element by position,
  an element added or removed whole checked once, and no check of
  whitespace-only text between elements. In XML, each element holding a text
  node that the diff lists with more than whitespace in it, at either end of a
  changed value, and the nearest ancestor both ends hold of each element the
  diff lists added or removed whole with such text anywhere in it, gets
  `text_equals` with its final text, ahead of the other checks, so a run
  added or removed with its words marks its paragraph. That ancestor is not
  the document's root unless the root holds text of its own. The check goes
  up from an element in mixed content (its parent holds text beside it, the
  root included) to the nearest that is not, then from one named by its tag
  or position alone to the nearest ancestor below the root named by an
  attribute, as AbiWord's `p` by `xid`, so it names a paragraph rather than a
  run a later save may split or merge. An element passed on the way that an
  identifier of its own (`id`, `xml:id`, `xid` or one ending in `:id`) names
  goes ahead of that ancestor, the outermost first, as an SVG `text` by its
  `id` in a layer named by its label, unless an identifier names the ancestor
  too, as the `text` above a `tspan` with an `id` of its own; one that only
  another attribute names, such as `xml:space`, goes after it, for when the
  ancestor cannot take the check, as when its text is too long. Either
  attribute holds the same value at both ends and names the element alone
  among its siblings at each. The check is kept when that element is the
  outermost such, at both ends, named without positions, held whole by the
  final view, its text changed, at most 2,000 characters and no timestamp.
  Where none can take it, an element added whole, named without positions,
  gets `text_equals` with its own text instead of a check that it is there,
  as a new paragraph in a section too long to check. The text nodes and runs
  inside a checked element, added and removed ones included, get no other
  check, but a changed name or attribute of an element inside it that both
  ends hold, such as a link's `href`, keeps its own, and so does an element
  added or removed there whose text is only whitespace, such as an image or a
  line break, which the text check never reads.

## Non-goals

- No DTD processing: no default attributes, entities, validation or catalog
  lookup, from an internal subset or an external DTD.
- No characters from elements that stand for them, such as Writer's `text:s`,
  `text:tab` and `text:line-break`, which are elements rather than text.
- No space between runs in an element that holds no text of its own outside
  `xml:space="preserve"`: a paragraph made only of runs separated by a bare
  space reads without it, since nothing tells that space from formatting.
- No regular expressions, case folding or Unicode normalization in text
  checks.
- No rule for save bookkeeping other than timestamps: a counter an app bumps
  on save, such as AbiWord's `history` `version`, `edit-time` and
  `last-saved`, is still suggested, by name, for the author to drop, since a
  number that went up is as often the user's edit.
- No paragraph for the changed text of a run named by an attribute of its
  own, such as a run among others of different formatting, in a paragraph
  holding no text of its own: its check names that run. A run added or
  removed whole is checked at its paragraph.
