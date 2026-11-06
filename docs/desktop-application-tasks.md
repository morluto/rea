# Desktop application tasks

A [desktop application export](desktop-application-export.md) can carry one
task: a prompt for a computer-use agent and checks that grade what the agent
left in the application's files. An agent, not REA, writes the prompt and the
checks from the change the capture recorded. REA validates the task against
the capture and keeps it only when its checks fail on the seed and all pass on
the captured end state. REA runs no model and no code the agent wrote: the
checks are declarative, and the exported verifier evaluates them the same way
REA does.

```sh
rea describe-desktop-application-task ./mousepad-capture --format json > draft.json
# edit the draft's task into task.json: a name, the user's request, the checks
rea export-desktop-application ./mousepad-capture ./mousepad-bundle --task task.json
agent-env run ./mousepad-bundle --task add-milk --agent claude-code
```

## Describe the change

`rea describe-desktop-application-task <capture-folder>` reads the capture and
its [state view](desktop-application-state.md) and returns Evidence with
operation `describe_desktop_application_task` and predicate type
`rea.desktop-application-task-draft`:

- `application`: the environment name the export would use, the title and the
  window class.
- `owned_paths`: the paths the export owns, the only ones whose files the
  app's `data/get` serves and checks can read.
- `checkpoints`: the two checkpoints compared, `baseline` for the seed and
  `final` for the end. They are the capture's first and last unless
  `--seed-checkpoint` and `--end-checkpoint` name others, as for the
  [export](desktop-application-export.md#the-seed-checkpoint), which takes
  the same options; a name the capture does not hold, or an end before the
  seed, is refused.
- `files`: each file under them whose state differs between those
  checkpoints, with its home path, role, its versions at both (`baseline` and
  `final`, the last recorded at or before each) and the net change between them, from the state view's own diff (`lines`, `values`,
  `keys` or `rows` with what was added, removed and changed, or `created`,
  `deleted`, `format`, `content`, `unreadable`; `content` also when the
  views hold only part of a file and match while the file changed). A
  database is compared by its rows, since its hash leaves out the `-wal`
  file. Text changes list each line
  once and add `line_counts`, the lines found at both ends whose number of
  occurrences changed. An XML file's change names its members by the
  [selectors](#pointers-and-selectors) checks use, as an archive's already
  does, and by position only where nothing names a member or where only the
  members' order changed. Views appear only for the files the suggestions
  cover, with arrays past 200 items and strings past 2,000 characters cut
  (`view_cut`).
- `values`, in each of those files: the values its change added, changed and
  removed, each with the `pointer` a check names it by, its `kind` (`added`,
  `changed` or `removed`), and `before` and `after`: the scalar, an element as
  compact XML with the text the XML reader kept, spaces between runs included,
  or a JSON value as compact JSON, cut at 600 characters, and null at the end
  that lacks it. A file created or deleted lists what its one end holds,
  `added` or `removed`: an archive's entries, an XML file's root element, a
  JSON file's members or a key file's keys, each whole once. A value only
  position reaches has `note: "by_position"`, and its pointer cannot go into a
  check; noise an app writes as it saves has `view_state`, `renumbered`,
  `volatile`, `timestamp` or `upkeep` (see `task`). `refers_to` names up to
  three other elements a value equals the `key` or `id` of, with the
  `attribute` holding it, as HomeBank's `category="44"` names
  `<cat key="44" name="Groceries"/>`; where several elements share that key,
  the one whose tag shares the attribute's stem, as `payee` and `<pay>`. What a check can
  name comes first, then what only position reaches, then noise. A file lists
  at most 20 values and 8 KB, the draft 24 KB, and `values_cut` says when a
  limit left some out. Values cover XML, archives, JSON and key files; a text
  or SQLite file's change and suggestions already carry its lines and rows.
- `task`: a draft with the name `change`, a placeholder prompt the export
  refuses, and suggested checks derived from the net change of the files with
  role `document`, or of the app's own state files when no document changed.
  A text file gains `lines_present` for its new lines and `lines_absent` for
  lines it lost (when either is at most ten), and `line_count` for each line
  holding a letter whose count changed; JSON and key files gain
  `value_equals` and `value_absent` by pointer; SQLite tables gain rows added,
  changed and removed, by primary key, and their new row count. An XML file,
  and the JSON, key file and XML views of a zip archive's entries, gain checks
  by [selectors](#pointers-and-selectors) and never through an element by
  position: in XML, first [`text_equals`](#whole-text) for each element whose
  text changed, then elements added or removed whole, then values changed,
  added and removed, an entry or a JSON value added whole through its
  members, and an empty array or object as it is.
  - A selector names a member by its tag, then by its identifiers (`name`,
    `id`, `xid`, `xml:id`), then by one other attribute, a name-like key such
    as Scribus's `ANNAME` or `inkscape:label`, a worded value or an integer of
    up to five digits first, then by two such attributes together, as
    Gnumeric's cells by `[@Col=3][@Row=2]`, and last by a coordinate, a long
    number or a token, such as `XPOS` or `ItemID`, or an attribute naming
    view state, such as which layer is `selected`. A pair counts every
    member holding both its values, whichever attributes that member ranks
    first. An element with identifiers is named by those alone. The selector
    must name the member alone at both ends, with the same values. An
    element whose one identifier changed, at its place among its tag's
    members, with every other attribute and its children alike, is that
    element renamed, as a MyPaint layer renamed from `Untitled` to `Sun`: it
    is named by its first other attribute naming it alone at both ends, as
    `[@src=data/layer-00.png]`, so the rename reads as its `name` changed,
    and the old name gets a check that it names nothing, unless its change
    is noise, as an id the app renumbered.
    An identifier the app numbers by position names nothing: where the
    members of a tag hold it as 1..N (or 0..N-1) in document order at both
    ends, members were inserted or removed, and every member another
    attribute names alone at both ends kept its number or moved it the way
    the count did, one at least, as Planner's task `id` after a task is
    inserted, members are paired by their other attributes, so an insertion
    reads as one task added. A value two members swap, or an id appended at
    the end, as Tellico's next `<entry id="4">`, leaves the ids identity.
  - The text check names the paragraph rather than a run inside it: it goes up
    from an element sitting in its parent's text, and from one named by its
    tag or position alone to the nearest ancestor named by an attribute, as
    AbiWord's `p` by its `xid`; where no attribute names one, to the nearest
    ancestor within three levels its tag names with no step by position, as
    MuseScore's `VBox` around untitled `<Text>` elements; and where only
    position reaches the element, to the ancestor above the outermost step by
    position, by an attribute of its own that names it alone where one does,
    as an ODS sheet's `table:table[@table:name=Q1 Sales]` above its rows. The
    text nodes and runs inside it get no other check, but an element holding
    no text that is added or removed there, such as an image or a line break,
    keeps its own, since the text check never reads it. A decimal that is an
    element's only text, such as a spreadsheet cell's, is checked by its
    number instead. Text that grew by whole lines and kept the rest, as a note
    gaining `olive oil` on a line of its own, gets a `text_contains` of the
    added lines instead, so a correct edit with a blank line after it or the
    line elsewhere still passes, and guards that the kept text is still there;
    text replaced, or grown inside a line, keeps `text_equals`. A record added
    or removed whole, an element holding only elements, its fields, such as
    Tellico's `<entry>` or a record of repeated `<field>` elements, never
    makes the list holding records of its kind a check, whose text would hold
    the records the edit left alone, except a record removed whole that only
    position names, whose absence only the list's text shows. Text made of
    runs is no record: an element whose tag names a paragraph or a piece of
    text (`p`, Writer's `text:p` and `text:h`, `h1` to `h6`, `li`, `para`,
    SVG's `text` and `tspan`, a `span` or an `a`), or whose runs split a
    sentence at a space, as `Meet ` and a linked `Monday`. Nor does an
    element holding a date the app stamps in parts take a text check.
  - An element added to a list, where another element of its tag is at either
    end, gets a `value_equals` for each of its attributes, best ranked first,
    at most six, leaving out its selector's attributes, identifiers, times,
    volatile values and view state, as HomeBank's new `<ope>` gets its
    `amount`, `category` and `payee`. An element whose other attributes, two
    or more, a like sibling holds every one of, as a new Planner task copies
    its neighbour's defaults, and any other element added whole, get a check
    that it exists. A record added to a list that a selector names, as
    Tellico's `<entry id="4">`, gets a `text_equals` for each field, at most
    five, each by its selector among the record's fields, as `[name=title]`,
    leaving out a field repeating the record's identifier, a date the app
    stamps in parts, and blank text or times. A record only position names,
    such as Osmo's `<record>` of fields, also gets a `text_contains` for each
    new field of three or more characters, at most five, at the nearest
    ancestor a check can name, each absent from that ancestor's text at the
    seed.
  - A decimal written as text, such as `146.83`, is suggested as a number
    with `tolerance: 0.001`, unless the seed's value is that close too.
  - Noise leaves the suggestions when the file's change holds anything
    else, a change only position reaches included: view state, which a tag
    or attribute on the way names (the cursor, a selection, scrolling, zoom,
    the viewport, windows, splitters, Inkscape's `namedview`, view and
    configuration settings, the printer, a save's history, edit time,
    editing duration and cycles, last-saved time, the generator and
    document statistics), or the value of a name-like attribute or `key` on
    the way, when it is one token of several words, as LibreOffice's
    `config:config-item[@config:name=CursorPositionX]` inside
    `[@config:name=ooo:view-settings]`; an attribute ending in `ID` or `Id`,
    or an `rsid`, that the app renumbered, with everything else in its
    element, as Gnumeric empties a formula cell whose shared expression it
    renumbers, and an identifier the app numbers by position; volatile
    values, UUIDs and epoch times, and durations and counts under a
    document's metadata; times the app stamps, also as a date written in
    parts whose tag, or one it sits in, names when the app made, changed or
    saved something, as Tellico's `<cdate>` of `<year>`, `<month>` and
    `<day>` (`cdate`, `mdate`, `created`, `modified`, `saved`, `updated`),
    which no check ever reads, while a date a user enters in parts, as a
    birthday, is an edit like any other; and `upkeep`, attributes the
    elements of one archive entry only gained while another entry holds the
    edit, as LibreOffice fills in `styles.xml` on save. However much noise
    comes first, it never takes a check's place. When the change holds
    nothing else, the checks stay and a note flags them: up to three in a
    document, and as many as fit in the app's own state, where a view
    setting may be the task.
  - Whitespace an app lays out between elements is not checked, and values
    that look like a time the app stamps, in ISO 8601, as C's `asctime`
    writes it (`Thu Nov  5 09:20:31 2026`) or as a time of day to the
    second (`05:16:21.675302540`), are left out; noise never makes its
    ancestor's whole text a check.
- `guards`: checks an author may add to show the edit left the rest alone,
  kept out of `task.checks`, with ids `guard-1` and on: for each suggested
  `value_equals` or `text_equals` on a member of a list, a field on up to
  two like siblings, nearest first, at its seed value, which the end holds
  too: the check's own field where like siblings hold different values in
  it, and otherwise one that varies among them, as Planner's `work` rather
  than the `type="normal"` every task shares; never through a sibling only
  position or a renumbered id pairs. Text that grew by lines gets a
  `text_contains` of what it kept, and a text file a `lines_present` of the
  unchanged list items beside its first new line with the same marker, as
  Zim's other `[ ]` action items, or else its nearest lines with words in
  them. At most four a file. They pass on the seed, which the export allows,
  since one check failing there is enough.
- `notes`: why `files` is empty, or why a file's suggestions are thin. Each
  note has a `code` and a `message`. For a draft with no files: `no_change`
  when no file under the home changed between the two checkpoints and nor
  did the application's dconf keys; `unowned_changes` when files changed but
  none under the owned paths, with up to five of them in `files`, each with
  its home path and role (desktop services' files last), and how many more
  in `more`; `uncheckable_changes` when the application's keys in a dconf
  database changed, with the database in `files`: no check reads dconf, and
  the export only writes the keys as they were at the seed checkpoint, so
  make the task's change one the app saves in a file; `unreadable_changes`
  when a dconf database changed but REA could not read it, with the read
  failure in `error` (install `dconf-cli` or set `REA_DCONF_COMMAND` when it
  is missing), since whose keys changed is then unknown; and `no_document`
  when no file has the document role, as when no window title shows the
  file's name. A capture again with `--state-path` naming the file, or
  `state_paths` on a build computer's `start_build_capture`, makes it the
  app's. For a drafted file, named in `file`: `by_position` when
  changes reach their element only by position, the tags no attribute names
  alone in `elements`, or when only the elements' order changed;
  `view_state_only` when every change is noise, the checks kept in
  `pointers`; `long_text` when an element's text changed past the 2,000
  characters a text check compares, the elements in `pointers`; `cut_view`
  when the views hold only part of the file; and `unreadable_view` when no
  check can read it, as a document REA reads as binary.

The suggestions are a starting point. Keep the ones that say what the user
did; drop the ones that only follow from how the app saves its file. Read
`values` for what changed and its pointers, and `refers_to` for what a number
stands for, before writing the prompt and any check of your own. A LibreCAD
capture that added four holes to a drawing rewrote it from DXF R12 to DXF 2007,
so most of its lines changed; the draft suggests counts of `SECTION`, `ENDSEC`
and `CIRCLE`, and only `CIRCLE` going from 5 to 9 is the user's change.

## The task file

```json
{
  "name": "add-milk",
  "prompt": "In Mousepad, add buy milk to my to-do list and save it.",
  "checks": [
    {
      "id": "milk",
      "kind": "lines_present",
      "file": "Documents/todo.txt",
      "lines": ["buy milk"]
    }
  ]
}
```

`name` is a portable bundle name other than `smoke` (lowercase letters, digits
and hyphens); `prompt` is what the user asks for, naming the app, since a
solving agent's own shell cannot see the computer's files and the app's name
sends it to the screen; `checks` holds 1 to 32
checks. Each check has a `kind`, a `file` given as a path under the home such as
`Documents/todo.txt`, and an optional `id` (`check-1`, `check-2` and so on by
position otherwise). A check reads the typed view `data/get` returns for that
file, in the shapes of the state view.

| Kind            | Fields                                                                | Passes when                                                                                        |
| --------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `file_present`  |                                                                       | The file exists                                                                                    |
| `file_absent`   |                                                                       | The file does not exist                                                                            |
| `lines_present` | `lines`                                                               | Every listed line is a whole line of the text view                                                 |
| `lines_absent`  | `lines`                                                               | None of the listed lines is                                                                        |
| `line_count`    | `exact` or `contains`; `equals`, `at_least` or `at_most`              | The number of lines equal to `exact`, or holding `contains`, compares so                           |
| `value_equals`  | `pointer`, `value`; optional `tolerance`                              | The pointer names a value equal to `value`, or within `tolerance` of it                            |
| `value_absent`  | `pointer`                                                             | The pointer names no value                                                                         |
| `text_equals`   | `pointer`, `value`; optional `normalize_whitespace`, `text_attribute` | The XML element's [whole text](#whole-text) equals `value`                                         |
| `text_contains` | `pointer`, `value`; optional `normalize_whitespace`, `text_attribute` | The XML element's whole text holds `value`                                                         |
| `member_count`  | `pointer`; optional `matching`; `equals`, `at_least` or `at_most`     | The number of [members of the array](#counting-members), or of those `matching` names, compares so |
| `row_present`   | `table`, `where`                                                      | A row of the SQLite table has every column in `where` equal                                        |
| `row_absent`    | `table`, `where`                                                      | No row does                                                                                        |
| `row_count`     | `table`; optional `where`; `equals`, `at_least` or `at_most`          | The number of rows, or of rows matching `where`, compares so                                       |

The rules both evaluators follow:

- An absent file reads as empty: no lines, values or rows. So `lines_absent`,
  `value_absent` and `row_absent` pass on it and a count of lines or rows is
  0; `member_count` fails, since its pointer names no array.
- A file that has no view (binary, over the read limit, or unreadable) fails
  every check but `file_present` and `file_absent`. Line checks need a text
  view, row checks a SQLite view and text checks an XML view, in a file or an
  archive entry; another format fails.
- Equality is JSON equality: numbers by value, never a boolean for a number,
  objects by their keys whatever their order, arrays in order.
- Pointers follow RFC 6901 (`~1` for `/`, `~0` for `~`) and must start with
  `/`; on an array a segment may be a selector, below. Key files read as
  `{"groups": {"GROUP": {"KEY": "VALUE"}}}`, so a setting is
  `/groups/GROUP/KEY`; XML as `{"root": {"name", "attributes", "children"}}`;
  SQLite as `{"tables": {"TABLE": {"columns", "rows"}}}`; a zip archive as
  `{"entries": [{"name", "format", "view", …}]}`; a gzip file, such as a
  Gnumeric `.gnumeric`, as the document inside it, so its pointers are those
  of the same document uncompressed.
- With `tolerance`, a non-negative number, `value` must be a number, and the
  value found passes when it is a number, or a string that is a decimal
  numeral such as `"5.0000000000000000"`, at most `tolerance` from `value`.
  `tolerance: 0` compares numerically, so `"1.2500"` equals `1.25`. Anything
  else fails as not a number.
- `contains` matches a line that holds it anywhere, case and all. Checks take
  no regular expressions: a pattern run on what the agent wrote could stall
  the verifier, and JavaScript and Python read some patterns differently.
- A check decided by what a view leaves out (`lines_absent`, `value_absent`,
  `row_absent`, the counts, `value_equals` of a whole object or array, and
  the text checks of an element) fails when that view is truncated; a check
  satisfied by what the view holds is decided on it. An element's text is not:
  the reader may have dropped text from between the runs it kept, so
  `text_contains` fails on a truncated view even where the kept runs hold its
  value. A text node or attribute value is whole, and decided.

The export refuses, naming the check, a file outside the owned paths, a file
spelled with a leading slash, `.` or `..`, a pointer into a file that is text
at the seed, as the bundle ships it, or at the end checkpoint, the empty
pointer (the whole file) except in `member_count`, a `matching` that is no
selector, a value that names the captured home, or the
capture host's name or `user@host` anywhere (which the
[export removes from the seed](desktop-application-export.md#host-name-and-user)), a
`tolerance` with a value that is not a number, an empty `text_contains`
value, or one of only whitespace with `normalize_whitespace`, an empty
`text_attribute`, a count without exactly one of `equals`, `at_least` and
`at_most`, and a value that looks like a date and time, in ISO 8601 or
`asctime`'s form. Other volatile
content, such as a
counter the app bumps on every save, is for the author to leave out.

## Pointers and selectors

An app that rewrites a document moves things: FreeCAD 1.0 records more
properties than 0.21, so a hole's radius sits at another position among its
siblings, and a plate's entry moves once a hole is added before it. A pointer
segment applied to an array may therefore name a member by what it holds
rather than by its position:

- `[KEY=VALUE]` names the member whose string field `KEY` is `VALUE`, such as
  a zip entry by `[name=Document.xml]` or an XML element by its tag,
  `[name=Object]`.
- `[@KEY=VALUE]` names the member whose `attributes` hold `KEY="VALUE"`, as
  the XML view keeps an element's attributes.
- `[>CHILD=VALUE]` names the XML element that has a child element `CHILD`
  whose text, every text node in it with each run of whitespace collapsed to
  one space and none at either end, is `VALUE`, for records that keep their
  fields as elements: Osmo's `<contact><first_name>Delphine</first_name>…`
  is `[name=contact][>first_name=Delphine]`. Any such child will do, and a
  member that is no element never matches.
- Conditions can follow one another, `[name=Object][@name=Hole]`, and all must
  hold. They compare strings only, the selector is escaped like any pointer
  segment (`~1` for `/`), and a value cannot hold `][`. A field whose key
  begins with `@` or `>` cannot be selected by.

A selector must name exactly one member. When several match, or none does
before the last segment, the check fails and says which selector matched what.
When the last segment's selector matches none, the pointer names no value:
`value_absent` passes, which is how a check says an element was removed, and
`value_equals` fails. On an object, a bracketed segment is an ordinary key.

A FreeCAD task that checks the user cut a 10 mm hole through the plate, in
FreeCAD 0.21 and 1.0 alike:

```json
{
  "name": "cut-hole",
  "prompt": "In FreeCAD, cut a 10 mm hole through the middle of the plate and save it.",
  "checks": [
    {
      "id": "cut",
      "kind": "value_equals",
      "file": "Documents/plate.FCStd",
      "pointer": "/entries/[name=Document.xml]/view/root/children/[name=Objects]/children/[name=Object][@type=Part::Cut]/attributes/type",
      "value": "Part::Cut"
    },
    {
      "id": "radius",
      "kind": "value_equals",
      "file": "Documents/plate.FCStd",
      "pointer": "/entries/[name=Document.xml]/view/root/children/[name=ObjectData]/children/[name=Object][@name=Hole]/children/[name=Properties]/children/[name=Property][@name=Radius]/children/[name=Float]/attributes/value",
      "value": 5,
      "tolerance": 0.01
    }
  ]
}
```

Before the edit the archive has no `Part::Cut` and no `Hole`, so both checks
fail on the seed; after it, `Radius` is `"5.0000000000000000"` and both pass.
A check decided by what a view leaves out depends, in an archive, on the entry
its pointer goes into: it fails when that entry's view is missing or
truncated, or when the entry is not listed and the listing is truncated. A
selector must see every member to know it names one, so a check whose pointer
searches an array the view may hold only part of fails as undecided: any array
of a truncated XML view, of a truncated entry's view, or the listing when it
is cut. A position is decided on what the view holds. Like a file, an entry
that has no view (binary, not read, or a database or archive inside the
archive) fails every check into its `view`; its `null` there is no value, while
an entry holding the JSON document `null` reads as `null`. Checks on its `name`,
`size`, `sha256` and `format` still read.

XML that uses namespaces is named as the document spells it, in both
evaluators: an element or attribute by its prefixed name, such as `text:p`
or `inkscape:label`, an element in a default namespace by its bare name, such
as `svg`, and namespace declarations as the attributes `xmlns` and
`xmlns:PREFIX`. Text is a string among an element's `children`. These checks
hold a poster's headline in an Inkscape SVG and a date in a LibreOffice Writer
document:

```json
[
  {
    "id": "headline",
    "kind": "value_equals",
    "file": "Pictures/poster.svg",
    "pointer": "/root/children/[name=g][@inkscape:label=Layer 1]/children/[name=text][@id=headline]/children/[name=tspan]/children/0",
    "value": "Summer Bake Sale"
  },
  {
    "id": "date",
    "kind": "value_equals",
    "file": "Documents/flyer.odt",
    "pointer": "/entries/[name=content.xml]/view/root/children/[name=office:body]/children/[name=office:text]/children/[name=text:p][@text:style-name=Subtitle]/children/0",
    "value": "Monday 24 November"
  }
]
```

Inkscape writes a line of text as a `tspan` inside its `text` element, and
Writer keeps a paragraph's style in `text:style-name`. A prefix is the one the
document uses, so a check names the prefixes the app writes.

## Whole text

A text node is only the stretch of text between two pieces of markup, and
apps split a paragraph into runs as they save it. AbiWord wraps text typed
into a reopened document in `c` elements, so changing a time to `3:30` saves
`<p>The team meeting starts at <c>3</c>:<c>30</c> in room 4.</p>`; Writer,
which records revision IDs by default, writes text typed in one session as
`text:span` runs. A `value_equals` on the paragraph's `children/0` then reads
`"The team meeting starts at "` and fails. `text_equals` and `text_contains`
read the element's whole text instead:

```json
{
  "id": "time",
  "kind": "text_equals",
  "file": "Documents/meeting.abw",
  "pointer": "/root/children/[name=section]/children/[name=p][@xid=3]",
  "value": "The team meeting starts at 3:30 in room 4."
}
```

- The pointer names an element of an XML view, in a file or in an archive
  entry's `view`, or a text node or attribute value in one, whose text is its
  value. Another format, a pointer into an archive outside an XML entry's
  view, or any other value fails, an element's `name` and the `doctype`'s
  fields included: they are strings of the view, not text of the document.
- An element's text is XPath's `string()` of what the view keeps: every text
  node in it and in its descendants, CDATA included, in document order, with
  nothing between them. The view drops whitespace-only text between child
  elements only in an element that holds no other text, outside
  `xml:space="preserve"`, so the space between two runs of a paragraph is
  part of its text. Elements that stand for characters, such as Writer's
  `text:s`, `text:tab` and `text:line-break`, add none.
- `text_equals` passes when the text equals `value` exactly, case and all;
  `text_contains` when it holds `value`, as a time within a sentence, so the
  check holds whatever the rest of the sentence says.
- `normalize_whitespace: true` collapses each run of XML whitespace (space,
  tab, carriage return, line feed) in both the text and `value` to one space
  and trims both ends before comparing, as XPath's `normalize-space()` does,
  for an app that reflows text or a value written across lines. A no-break
  space is not whitespace there.
- `text_attribute` reads text an app keeps in an attribute: the element's
  text is then that attribute's values on it and its descendants, joined in
  document order, and its text nodes are left out. Scribus keeps a text
  frame's text as `<StoryText><ITEXT CH="Spring "/><ITEXT CH="Fair"/></StoryText>`,
  one `ITEXT` per run of formatting, so the check below reads `Spring Fair`
  however the runs are split. The pointer must name an element; a text node
  or attribute value fails.

```json
{
  "id": "headline",
  "kind": "text_equals",
  "file": "Documents/flyer.sla",
  "pointer": "/root/children/[name=DOCUMENT]/children/[name=PAGEOBJECT][@ANNAME=Headline]",
  "value": "Spring Fair",
  "text_attribute": "CH"
}
```

## Counting members

`member_count` counts the members of the array its pointer names: a JSON
array, or an XML element's `children`. `matching`, a selector of one or more
conditions as [above](#pointers-and-selectors), `[>CHILD=VALUE]` included,
counts only the members it matches, however many; without it every member
counts. An element's children hold its text nodes too, so give `matching`
for XML, such as `[name=entry]`. A Tellico task that adds one book to a
collection of 12:

```json
{
  "id": "one-more-book",
  "kind": "member_count",
  "file": "Documents/books.tc",
  "pointer": "/entries/[name=tellico.xml]/view/root/children/[name=collection]/children",
  "matching": "[name=entry]",
  "equals": 13
}
```

It takes exactly one of `equals`, `at_least` and `at_most`. The empty
pointer `""` names the whole file, for a JSON file whose top level is an
array. A pointer that names no array, an absent file's included, fails and
says what it found there. Like the other counts, it is undecided on a view
that may hold only part of the array.

## Validation and export

`rea export-desktop-application <capture> <directory> --task <task.json>`
evaluates the checks on the capture's state view: on each file as it was at
the seed checkpoint, which is the seed, as the bundle ships it with the
capture host's name and user removed, and at the end checkpoint, the
captured end state. Those are the capture's first and last checkpoints unless
`--seed-checkpoint` and `--end-checkpoint` name others.
It refuses a task whose every check passes on the seed, and a check that fails
on the end state, with that check's reason. Only a failure on what the seed's
view shows counts: a task whose checks fail on the seed only because a view
could not be read or may have left out what they look for, such as a line past
the 5,000 a text view keeps, is refused, naming each failure. A capture yields
one task, so the option is taken once. The result's `task` names the task, its
number of checks and those that fail on what the seed shows. A refused task
writes no bundle.

The bundle then holds, besides the app and `tasks/smoke.json`:

| Path                               | Contents                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tasks/<name>.json`                | Deploy the app, deploy the agent and its skills, record the screen, prompt the agent, run the verifier, stop recording |
| `artifacts/<name>-check/verify.py` | Reads the app's `data/get` through the computer and evaluates the checks, one result per check                         |
| `evals/<env>.toml`                 | The task, so a run of the bundle runs it; the smoke task runs with `--task smoke`                                      |

The verifier finds the app among the computer's child environments, calls its
`data/get` under the run's grant of the computer's control token, and reads
the `state` data part. It reads again until the app's files settle, as
[grading once the app has saved](desktop-application-export.md#grading-once-the-app-has-saved)
describes, and each result's `settled` says whether they did, and `read_cut`
whether the bound cut a read still running. It raises when the app cannot be reached, so the run
fails rather than scoring the agent. The README lists the task, its prompt, its
checks and the recipe below.

## Solve rate

REA does not run agents. To measure how often an agent solves the task, run it
k times, three by default, and count the runs whose summary line says
`passed`:

```sh
for run in 1 2 3; do
  agent-env run ./mousepad-bundle --task add-milk --agent claude-code --model MODEL
done
```

The agent defaults to Claude Code and the model is the caller's choice (Claude
Sonnet 5.5 is a reasonable reference). A run reported as `scored below 1`
failed the checks and counts as a miss; one reported as `failed` did not finish,
as when the computer or the app could not be reached, and is run again rather
than counted. Each run's instance keeps the verifier's results per check under
`verifications`.
