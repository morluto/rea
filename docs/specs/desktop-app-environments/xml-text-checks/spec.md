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
  of spaces and line breaks one space, the ends trimmed. A document without a
  DOCTYPE has no `doctype`.
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
  entry of another format; a value that is neither an element nor text; and,
  as undecided, an element in a view that leaves something out, or a selector
  searching an array such a view may cut. A text node is whole, so it is
  decided on a truncated view.
- Refusals: the task parser refuses the empty pointer, a pointer not starting
  with `/`, an empty `text_contains` value or one that is only whitespace
  with `normalize_whitespace`, and a value that looks like an ISO 8601 date
  and time; the export refuses a text check into a file read as text.
- Draft: in XML, a file's or an archive entry's, each element holding a text
  node that the diff lists with more than whitespace in it gets `text_equals`
  with its final text, the outermost where one holds another, when it is an
  element at both ends whose text changed, the final view holds it whole and
  its text is at most 2,000 characters and no timestamp. In a file it is named
  by the most general selector naming each member alone, by position where
  none does; in an archive by the diff's own selectors, never through an
  element by position. The text nodes and runs inside it get no other check.

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
