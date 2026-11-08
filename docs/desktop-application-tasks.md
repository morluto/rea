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
  `volatile`, `timestamp`, `upkeep` or `layout` (see `task`). A record of
  text fields added to a list of its kind, as GnuCash's
  `<gnc:transaction>`, is listed field by field, and a field that lists
  records, as its `<trn:splits>`, record by record, so the cut never hides
  one. `refers_to` names up to
  five other elements a value equals the `key` or `id` (`xmi:id` among them)
  of, outside a view the app keeps of the document, as Umbrello's
  `listview` mirroring its model by id, with the
  `attribute` holding it, as HomeBank's `category="44"` names
  `<cat key="44" name="Groceries"/>`, or the id a child element holds, as a
  GnuCash split's `<split:account>` names the account whose `<act:id>` it
  is, shown with its name, `<gnc:account …><act:name>Groceries</act:name>…`;
  an element added whole lists those of the records of attributes it nests
  too, as a KMyMoney transaction's splits name their `<ACCOUNT>` and
  `<PAYEE>`, each once. Where several elements share that key, the one
  whose tag shares the attribute's stem, as `payee` and `<pay>`, and of
  those the one named for the attribute, as `account` an `<ACCOUNT>` before
  an `<ACCOUNTID>`. A plain number names an element only through an
  attribute so named or ending in `id`, `ref` or `key`, so a list's
  `count="5"` names no `<FIXVERSION id="5"/>`. A value that changed lists,
  in `alternatives`, its pointer naming the element by each other identifier
  or name-like attribute it holds alone among its tag's members, up to
  three, as an Inkscape text's `[@inkscape:label=Headline]` beside its
  `[@id=text12]`, for a check to name it by instead; an element its tag
  alone names inside the first one a condition names, as an EPUB chapter's
  `h1`, by its `[@id=chapter-two]`. What a check can
  name comes first, text an edit changed before the rest, so no cut drops
  the edit, then what only position reaches, then noise. A file lists
  at most 20 values and 8 KB, the draft 24 KB, and `values_cut` says when a
  limit left some out. Values cover XML, archives, JSON and key files; a text
  or SQLite file's change and suggestions already carry its lines and rows.
- `task`: a draft with the name `change`, a placeholder prompt the export
  refuses, and suggested checks derived from the net change of the files with
  role `document`, or of the app's own state files when no document changed,
  excluding locks the export leaves out of the seed. App state files ending
  in `.log` remain eligible for checks.
  A text file gains `lines_present` for its new lines and `lines_absent` for
  lines it lost (when either is at most ten), and `line_count` for each line
  holding a letter whose count changed; a new line holding a value REA
  recognizes as generated, such as a named epoch time or `ID_329023692`, gets a
  `line_count` of the lines `contains` its text up to that value, as
  `<node TEXT="Water filter" ID="`, at the end's number, where both views
  hold the whole file, instead of a `lines_present` another save would
  fail, or a `volatile_lines` note when no text comes before it. UUID-shaped
  text stays exact because its shape alone does not show that it was generated;
  JSON and key files gain
  `value_equals` and `value_absent` by pointer, a JSON array's records named
  by an id field each holds alone at both ends (`id`, `uid`, `uuid`, `guid`,
  `key` or a name ending in `_id` or `Id`), as `/lists/[id=chores]`,
  whatever order the app saves them in; where the app generated that id, a
  record both ends hold is named by its kind field and its first name-like
  string field (a key ending in `name`, `title`, `label` or `caption`),
  nearest first and up to three keys deep, that holds the same string at
  both ends and names it alone at each, as TreeLine's category by
  `/nodes/[format=CATEGORY][>data~1NAME=Science]`, and by its id where none
  does, as `/nodes/[uid=7584d494d9f511f1a873edd4f1920549]` once its name
  changed; and a record only one end holds is named by such a field that
  names it alone at its end and nothing at the other, as TreeLine's new book by
  `/nodes/[format=BOOK][>data~1Title=The Silk Roads]`, its other fields
  checked through that selector and the fields the selector reads not, nor
  a field holding what every like record (one of its kind) at the end holds
  there, as the empty `children` of every book; and
  by position only where nothing names a record, as a new book whose title
  another book holds, with a `by_position` note listing those checks;
  never a value that is a uid the app generates (a
  GUID, or 32 hex digits as TreeLine's uuid1), nor a check the seed already
  passes, as a new record's `format` where another record of that kind held
  its place; a removed record is checked gone by its own pointer, as
  `/lists/[id=chores]`, and only where the end holds nothing there, so a
  record only position reached, whose place another took, is left to the
  count; `member_count` checks of the
  arrays whose members were added or removed, of the members' kind where
  records share a `type`, `kind`, `format` or `category` field, as `/nodes`
  matching `[format=BOOK]`, and a count guard of the innermost array an edit
  went through, as for XML; SQLite tables gain rows added,
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
    Gnumeric's cells by `[@Col=3][@Row=2]`, then by a coordinate, a long
    number, a length with its unit, as `svg:height="2.629cm"`, an `xml:id`
    or `draw:id` of the form `id2` that LibreOffice numbers anew as it saves,
    so a Draw shape is named by its `draw:name`, or a token,
    such as `XPOS` or `ItemID`, or an id of random case, as Umbrello's
    `ubcgF2AWfBmHh` (`u` and twelve letters and digits), an automatic style name an app numbers as it
    saves and renumbers on reload, as LibreOffice's
    `presentation:style-name="pr1"` (`P1`, `T1`, `MT1`, `L2` on a
    `*:style-name`), so a slide's frames are named by `presentation:class`,
    or an attribute naming
    view state, such as which layer is `selected`, and last by a child
    element's text, `[>CHILD=VALUE]`, a name-like tag first, as Osmo's
    record by `[>first_name=Delphine]`, MuseScore's `<Text>` by
    `[>style=Title]`, a spreadsheet row by its label cell, or GnuCash's
    transaction by `[>trn:description=Greenleaf Market]`: text of at most 64
    characters, never a time or a token or id a program generates; then by
    an identifier a child carries, `[>CHILD@ATTR=VALUE]`, as a GtkBuilder
    `<child>` by `[>object@id=submit_button]`, never one an app generates or
    numbers anew as it saves; and then by text a child joins from elements
    of its own, as Glade's `[>packing=TrueTrue1]` from a widget's packing
    properties, which moving the widget changes. A pair
    counts every member holding both its values, whichever attributes that
    member ranks first. An element with identifiers is named by those alone;
    an id the app generates, as Freeplane's `ID_329023692`, or a GUID in
    any attribute, braced or not, as VYM's `uuid="{18eadb5d-…}"`, ranks
    last, after a child's text, so a new node is named by its `TEXT` and a
    new VYM branch by `[>heading=Sunset boat tour]`, while a member
    both versions hold pairs by such an id first, so records that keep their
    UUIDs and swap titles read as two title edits. A value that stands for
    none, as Grisbi's `Id="(null)"` on every transaction, names nothing, so a
    new transaction is named by its `Nb`. A child's text is
    counted on every sibling, one an identifier names included, so a title
    two records share names neither. The selector must name the
    member alone at both ends, with the same values; a child's text names a
    member that is in one version only when the list's length changed, so a
    row whose one cell an edit changed stays that row. An element whose one
    identifier changed, at its place among its tag's members, with every
    other attribute and its children alike, is that element renamed, as a
    MyPaint layer renamed from `Layer` to `Sun`: it is paired by its first
    other attribute naming it alone at both ends, as
    `[@src=data/sun.png]`, so the rename reads as its `name` changed, and
    the old name gets a check that it names nothing, unless its change is
    noise, as an id the app renumbered. Where that attribute's values number
    the members in document order, as MyPaint 2 writes `src` as
    `data/layer-00.png`, `data/layer-01.png` and on along the stack and
    renumbers them when a layer moves, each version is named by its own
    value of the renamed identifier instead, `[@name=Sun]` and
    `[@name=Layer]`.
  - A child of the document's root that its tag alone names, and that holds
    a list (two or more elements of one tag and no text of its own) and has
    an identifier, also gets a condition that keeps it named if the app adds
    a sibling of its tag, as Dia adds an empty `Background` layer each time
    it reopens and saves a diagram: an id other than `name` both ends hold,
    as Inkscape's `[name=g][@id=layer1]`, which a new sibling would not
    share; else the text of a child both ends hold, as Dia's
    `[name=dia:layer][>dia:object=#Receive order#]`, which an empty sibling
    lacks; else its `name`, which a new one may repeat. Deeper, a member of
    a list named for its tag, as Gnumeric's `gnm:Sheet` in `gnm:Sheets`,
    holding elements and its tag alone naming it, gets an id, else a
    name-like child's text, `[name=gnm:Sheet][>gnm:Name=Budget]`, else its
    `name`. Other steps, and elements with neither, stay as they are.
    An identifier the app numbers by position names nothing: where the
    members of a tag hold it as 1..N (or 0..N-1) in document order at both
    ends, members were inserted or removed, and every member another
    attribute names alone at both ends kept its number or moved it the way
    the count did, one at least, as Planner's task `id` after a task is
    inserted, members are paired by their other attributes, so an insertion
    reads as one task added. A value two members swap, or an id appended at
    the end, as Tellico's next `<entry id="4">`, leaves the ids identity. An
    identifier numbering the members 0..N-1 in document order at both ends,
    where members came or went, as Parley numbers its `<entry id="6">` by
    where it saves it, ranks after a child's text where a member has one, so
    a new entry is `[>translation=library]` and its kept neighbours are named
    alike; Tellico's ids, which count from 1, Tiled's and Rosegarden's,
    whose members hold no text, stay identity. An element a change added that
    holds nothing but the id of a record it added elsewhere, as Parley's
    lesson membership `<entry id="6"/>`, is `upkeep`, listed with `refers_to`
    on that record, never a check or a count.
  - The text check names the paragraph rather than a run inside it: it goes up
    from an element sitting in its parent's text, and from one named by its
    tag or position alone to the nearest ancestor named by an attribute, as
    AbiWord's `p` by its `xid`, unless it is a field its tag names in a
    record of two or more fields holding text, as QElectroTech's `<text>`
    beside `<info_name>` in a `<dynamic_elmt_text>`, or KmPlot's
    `<equation-0>` beside `<arg-min>`, which is checked itself rather than
    the record whose text joins its fields; one line of text the app lays
    out between line breaks, as KmPlot's formula before the next element, is
    checked, and its siblings guarded, with `normalize_whitespace: true`,
    and text whose whitespace alone changed, as a formula the app moved to
    an indented line of its own, gets no check; where no attribute names one, to the nearest
    ancestor within three levels its tag names with no step by position, as
    MuseScore's `VBox` around untitled `<Text>` elements; and where only
    position reaches the element, to the ancestor above the outermost step by
    position, by an attribute of its own that names it alone where one does,
    as an ODS sheet's `table:table[@table:name=Q1 Sales]` above its rows. The
    text nodes and runs inside it get no other check, but an element holding
    no text that is added or removed there, such as an image or a line break,
    keeps its own, since the text check never reads it. A decimal that is an
    element's only text, such as a spreadsheet cell's, is checked by its
    number instead. Free text that gains a line, such as a shopping list,
    uses `text_equals` on the whole text: the current XML checks cannot
    compare an unstructured line as a whole item. This can reject a correct
    edit that puts the item elsewhere or changes spacing. Text an app keeps in an attribute, one element per run, as Scribus's
    `<StoryText><ITEXT CH="Spring "/><ITEXT CH="Fair"/>`, gets a `text_equals`
    with `text_attribute` on the nearest ancestor an attribute names, as
    `[name=PAGEOBJECT][@ANNAME=Headline]` with `"text_attribute": "CH"`, where
    that ancestor holds no text nodes and the attribute's holders are runs,
    none inside another and none carrying an identifier or a name-like
    attribute beside it, as Umbrello's `<ownedAttribute xmi:id="…"
    name="email" visibility="private"/>`, a record whose attributes are
    checked one by one, two or more or one holding words with a space: an
    element's own attribute, as a Freeplane node's `TEXT` beside the nodes in
    it, or a lone value, as `<Bool value="false"/>`, is checked where it is.
    The check covers that attribute and the runs holding it; another change
    in the frame, as a run's `FONT`, keeps its own check. A record added
    or removed whole, an element holding only elements, its fields, such as
    Tellico's `<entry>` or a record of repeated `<field>` elements, never
    makes the list holding records of its kind a check, whose text would hold
    the records the edit left alone, except a record removed whole that only
    position names, whose absence only the list's text shows. Text made of
    runs is no record: an element whose tag names a paragraph or a piece of
    text (`p`, Writer's `text:p` and `text:h`, `h1` to `h6`, `li`, `para`,
    SVG's `text` and `tspan`, a `span` or an `a`), one inside such an
    element, as Word's `<w:r>` run in its `<w:p>`, one whose elements are all
    inline formatting (`b`, `i`, `u`, `em`, `strong`, `bold`, `italic`, a
    `span`, `a`, `code`, `sub`, `sup` and the like, Gnote's `size:` and
    `link:` runs), as `<list-item><bold>olive oil</bold></list-item>`, or
    whose runs split a sentence at a space, as `Meet ` and a linked
    `Monday`. Nor does an element holding a date the app stamps in parts
    take a text check.

  - An element added to a list, where another element of its tag is at either
    end, gets a `value_equals` for each of its attributes, best ranked first,
    at most six, leaving out its selector's attributes, identifiers, times,
    volatile values, view state and values standing for none, as HomeBank's
    new `<ope>` gets its `amount`, `category` and `payee`; a value two or
    more like siblings all hold, as Grisbi's `Cu="1"`, comes after those
    that vary, as its `Pa`, `Ca`, `Dt` and `Am`. Records of attributes
    alone that it nests, as a KMyMoney `<TRANSACTION>` its `<SPLITS>` of
    `<SPLIT>`, get a `value_equals` of each attribute whose values vary among
    the like records, its own and those under its like siblings, at most
    three a record and six in all, as each split's `value` and `payee`, but
    not one every split holds alike, as `price="1/1"`, nor one each holds
    equal to an earlier one, as `shares` repeats `value`. Each record is
    named by an identifier that the app neither generates nor numbers anew
    in every record holding such a list, as KMyMoney's `S0001` in every
    transaction, else by its best ranked attribute short of a coordinate or
    an amount, as `[name=SPLIT][@account=A000001]`. An element whose other attributes, two
    or more, a like sibling holds every one of, as a new Planner task copies
    its neighbour's defaults, and any other element added whole, get a check
    that it exists; of those copied, an attribute naming an element the seed
    holds by an id that is no plain number, as an Umbrello attribute's
    `type` its data type, is the user's choice and keeps its check. A record added to a list that a selector names, as
    Tellico's `<entry id="4">` or Osmo's `<record>` by its first name, gets
    a `text_equals` for each field, at most five, each by its selector among
    the record's fields, as `[name=title]`, leaving out a field repeating the
    record's identifier, the field its selector names it by unless it is
    the only one left, as a new VYM branch's `<heading>`, a value every
    like record holds in that field, as Osmo's `<group>None</group>`, noise,
    a field holding ids of its own, a date the app stamps in parts, and blank
    text or times; a field that lists records, as GnuCash's `<trn:splits>`,
    gets its records' fields instead, each record by its own selector. An
    attribute every like record holds alike, as GnuCash's `version`, is the
    format's and gets no check. A record only position names also gets a
    `text_contains` for each new field of three or more characters, at most
    five, at the nearest ancestor a check can name, each absent from that
    ancestor's text at the seed.
  - Where members of a list were added or removed, a `member_count` of the
    list's members of their tag, and of their kind where they share one
    (`type`, `kind` or `shape`, as `[name=dia:object][@type=Flowchart - Box]`),
    unless every member of the tag holds a value of its own, as Tiled's
    objects a free-form `type` (`well`, `door`, `gate`), which labels each
    rather than grouping them,
    equal to the end's number, which differs from the seed's: at most two a
    file, the shallowest lists first, after the other checks. None for a
    list of one member at both ends, as a style an app adds for a run, for
    members of an element a text check reads, which are runs of its text,
    for an element in mixed content, or for noise.
  - A decimal written as text, such as `146.83`, is suggested as a number
    with `tolerance: 0.001`, unless the seed's value, read as the evaluator
    reads a number (`10` and `1e1` included), is that close too. A
    `value_equals` that would pass on the seed's value is not suggested.
  - An element placed by its own position, holding numeric `x` and `y` as a
    like sibling does, as Xournal++ places each `<text>` note on a layer, is
    an item of its own, never a run of the others' text: one added whole
    gets a `text_contains` of its text on the element holding the items,
    which passes wherever it is placed, and that list's `member_count`.
  - Noise leaves the suggestions when the file's change holds anything
    else, a change only position reaches included: view state, which a tag
    or attribute on the way names (the cursor, a selection, as VYM's
    `<select>`, the layer, frame,
    view or colour the app has current, as Pencil2D's `currentLayer`,
    scrolling, zoom, the viewport, windows, splitters, a list or tree view
    mirroring the document, as Umbrello's `listview`, Inkscape's `namedview`, view and
    configuration settings, the printer, a save's history, edit time,
    editing duration and cycles, last-saved time, the generator and
    document statistics, and a preview or thumbnail the app renders, as
    Xournal++'s `<preview>`), or the value of a name-like attribute or `key` on
    the way, when it is one token of several words, as LibreOffice's
    `config:config-item[@config:name=CursorPositionX]` inside
    `[@config:name=ooo:view-settings]`, or a settings path ending in how a
    panel shows (`visible`, `hidden`, `expanded`, `geometry`, `size` and the
    like), as VYM's `<setting key="/treeeditor/visible">`; an identifier the
    app numbers by position. An `Id` suffix alone does not show that an
    attribute is generated, so relationship fields such as `accountId` are
    retained; other save-generated IDs may need manual review; volatile
    values, UUIDs and epoch times, binary data encoded as base64 (a PNG's
    `iVBORw0KGgo`, or 256 or more base64 characters mixing cases and
    digits), an id counter (`uniqueid`, `nextobjectid`), a value equal to an
    id the change gave a new element where a counter or that element holds
    it, as Umbrello's `lastobject` holds the new attribute's `xmi:id`, but
    never a reference on an element both ends hold, as a KMyMoney split
    moved to a new account, and durations and counts under a document's metadata; times the app stamps, also as a date written in
    parts whose tag, or one it sits in, names when the app made, changed or
    saved something, as Tellico's `<cdate>` of `<year>`, `<month>` and
    `<day>` (`cdate`, `mdate`, `created`, `modified`, `saved`, `updated`,
    `entered`), or written whole under such a tag, as GnuCash's
    `<trn:date-entered><ts:date>2026-11-06 08:53:08 +0000`,
    which no check ever reads, while a date a user enters in parts, as a
    birthday, is an edit like any other; an id the app assigns, an `id`
    element with `type="guid"`, as GnuCash's `<trn:id>`, and text of control
    characters, as its unset options hold; `upkeep`, a change inside an
    app's `slots`, as GnuCash's `book:slots`, which it adds to and fills on
    reopening a book, a count an app keeps of its members, an attribute
    whose key ends in `count` or an element whose tag names a count, whose
    integer changed and at each end equals how many elements of one tag it,
    or the element holding the text, holds there, the counter left out, as
    VYM's root `branchCount`, KMyMoney's `<TRANSACTIONS count="5">` or
    GnuCash's `<gnc:count-data>`, or, for a counter the change added, how
    many of one tag, more than one, it holds as children, as FreeCAD's
    `<ObjectDeps Count="2">`, while a count a user enters, as an item's
    `<count>`, is an edit, and attributes the elements of one archive entry only
    gained while another entry holds the edit, as LibreOffice fills in
    `styles.xml` on save, and, while a change outside them is the edit, any
    change in `styles.xml`, in a document's style containers or its master,
    handout and notes pages, or to an attribute naming an automatic style
    (`P1`, `MT1`) at both ends, as Impress after a reload wraps its master pages' fields in a new `MT1` style and
    rewrites list style `L2`, and a text showing another field that changed
    alike, its element beside a field naming that one's key, as
    QElectroTech's `<dynamic_elmt_text>` shows a component's label in its
    `<text>` beside `<info_name>label</info_name>`; and `layout`, attributes holding a list of
    numbers, as Dia's `obj_bb` `6.3225,6.15;12.5775,8.15`, or a number a
    name on its way calls layout (a position, point, box, corner, width,
    height, side or offset, as `elem_width`), that changed in an element up
    to three levels below one whose text changed, below the root's own
    children, while their own element's text did not, as Dia moves and
    resizes a box around its new text, or below an element whose tag names a
    diagram, widget, canvas or scene while the model change is elsewhere, as
    Umbrello grows a class's `classwidget` `height` when an attribute is
    added; an order's `<amount value="12"/>` beside its new description is
    content. Geometry that changed with
    no text beside it, as a CAD sketch's, is content. However much noise
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
  `value_equals` or `text_equals` on a member of an XML list, or a
  `value_equals` through a JSON record added whole, as TreeLine's new book's
  `data/Author` gives
  `/nodes/[format=BOOK][>data~1Title=Small Engines of Life]/data/Author`
  (its like records are those of its kind, named as both ends pair them,
  and it reads only the check's own field), a field on up to
  two like siblings, those sharing most of the attributes its selector
  names it by and its type, as a cell's `Row` or `Col` and `ValueType`,
  then the nearest first, at its seed value, which the end holds
  too, trying at most the 16 nearest, so a guard costs the same among
  thousands of siblings; for a member named as a field, by a name-like attribute alone, as
  QElectroTech's `elementInformation[@name=label]`, the like siblings of
  the nearest record out that hold that field too come first, so the other
  components' labels guard a component's label rather than its other
  fields: the check's own field where like siblings hold different values in
  it, and otherwise one that varies among them, as Planner's `work` rather
  than the `type="normal"` every task shares, but not one numbering the
  members in order, as MyPaint's `src`; never through a sibling only
  position pairs. A guard never selects its sibling by
  what it reads: a sibling its selector names by the attribute the guard
  checks, or by a value that is or holds the text it reads, as Glade's
  `[>object=CancelTrueTrueTrue]` for a button's `Cancel` label, is named by
  another identifier, name-like attribute or child's text it holds alone
  at both ends instead, as Tiled's objects by `[@id=2]` rather than the
  `name` the guard reads, or Glade's button by `[>packing=TrueTrue0]`, or
  else the guard reads another field, or there is none. A `text_equals` with `text_attribute`
  reads its siblings the same way. A text file gets a `lines_present` of the
  nearest two unchanged lines of its first new line's kind, list items with the same
  marker, as Zim's other `[ ]` action items, or lines the same command
  opens, as the other headings after LyX's `\begin_layout Section`, or lines
  of the same keyword or `key:` in other records, as a gettext catalogue's
  other `msgstr` lines rather than the edited entry's own `msgid`, or else
  its nearest lines with words in them; each text both ends hold once, never
  a line with no text of its own, a command such as `\end_layout`, tags
  alone such as `<fonts>` or `</node>`, or a key alone such as a RedNotebook
  day's `24:`, nor a line that repeats; an item placed by its own position
  that an edit added, a `text_contains` of each of up to four kept items'
  text, nearest first. Where members were only edited, a
  `member_count` of the innermost list holding the edited element that an
  edit goes through by a member with like siblings, a record rather than a
  field of one (a member named by a name-like attribute alone that the
  record's like siblings hold too), of the edited member's tag and kind, at
  the seed's number, as Dia's boxes in their layer, MyPaint's layers in
  their stack or Glade's buttons in their button box: no member of the kind
  added or removed; never of runs in an element a text check reads, and
  only where the end holds the same number. A guard of a coordinate comes
  after those of text. At most four a file besides the count guard, which
  sits outside that cap, so sibling guards never squeeze it out. They pass
  on the seed, which the export allows, since one check failing there is enough.
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
  when the views hold only part of the file; `unreadable_view` when no
  check can read it, as a document REA reads as binary;
  `volatile_lines` when a text file gained lines holding a value the app
  generates with no text before it to count them by; and `read_as_text`
  when a text file opens like XML, with a declaration, a DOCTYPE or an
  element, but reads as text because its DOCTYPE has an internal subset or
  it is not well formed, so its checks compare lines that hold attributes in
  the order the app wrote them.

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
- `[>PATH=VALUE]` names the member that holds `VALUE` at a path of one to
  three `/`-separated steps inside it. `>` reads XML and JSON differently:

  | Form                                   | In an XML element                                                                                                                               | In a JSON record                                    |
  | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
  | `[>CHILD=VALUE]`                       | a child element `CHILD` whose text, every text node in it with each run of whitespace collapsed to one space and none at either end, is `VALUE` | the string field `CHILD`, compared whole            |
  | `[>A/B=VALUE]`, up to `[>A/B/C=VALUE]` | a child `A` with a child `B` of that text                                                                                                       | the string at `member.A.B`, compared whole          |
  | `[>A@ATTR=VALUE]`, `[>A/B@ATTR=VALUE]` | a child `A` (or its child `B`) whose attribute `ATTR` is `VALUE`                                                                                | the field named `A@ATTR`: `@` is part of a JSON key |

  Records that keep their fields as elements are named by a child's text:
  Osmo's `<contact><first_name>Delphine</first_name>…` is
  `[name=contact][>first_name=Delphine]`. A GtkBuilder `<child>` is named by
  the id its widget carries, `[name=child][>object@id=submit_button]`, and a
  TreeLine node by a field of its `data`,
  `[format=BOOK][>data/Title=The Silk Roads]`. Any element on the way will
  do; a path with more than three steps, or an empty one, is no selector;
  and a missing step, or a value at its end that is not a string, matches
  nothing.

- Conditions can follow one another, `[name=Object][@name=Hole]`, and all must
  hold. They compare strings only, the selector is escaped like any pointer
  segment, so a path's `/` is `~1` inside a pointer,
  `/nodes/[format=BOOK][>data~1Title=The Silk Roads]`, and a `/` in a key
  cannot be a step; a value cannot hold `][`. A JSON field whose key begins
  with `@` or `>` is selected through a path, `[>@type=Book]`.

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
conditions as [above](#pointers-and-selectors), `[>PATH=VALUE]` included,
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
