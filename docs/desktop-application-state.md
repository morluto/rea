# Desktop application state

`rea inspect-desktop-application-state <capture-folder>` reads a folder written
by [desktop application capture](desktop-application-capture.md) and describes
the application's state: which observed files are the application's, what each
retained version contains as typed JSON, and how each file changed between
checkpoints. It reads only the capture folder; the application is not run
again.

```sh
rea inspect-desktop-application-state ./mousepad-capture --format json
```

The result is Evidence with operation `inspect_desktop_application_state` and
predicate type `rea.desktop-application-state`. Its confidence is `inferred`,
because roles come from heuristics; the views themselves are read from the
retained bytes, which are checked against their SHA-256 before use.

## Paths and roles

The view covers every file retained at the baseline and every file that
changed later. Each path records the evidence the capture holds about it:

| Reason                   | Meaning                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| `state_directory`        | It lies in one of the application's state directories, in either spelling |
| `opened_by_application`  | An application process held it open during a sample                       |
| `named_in_window_title`  | An application window title spelled its name or `~/` path on its own      |
| `selected_path`          | It lies under a `--state-path` or absolute `--argument` of the capture    |
| `dconf_application_keys` | It is a dconf database holding groups whose path names the application    |
| `desktop_service`        | It lies where desktop services and toolkits keep shared files, or caches  |
| `desktop_trash`          | It lies in the desktop Trash, `~/.local/share/Trash`                      |

A folder beside a state directory whose name differs from it only in letter
case counts as that state directory, so a profile the application first
creates during the capture, such as GIMP's `~/.config/GIMP` beside the
candidate `~/.config/gimp`, is its state too.

The role follows from the reasons, in this order: `shared_desktop` for a file
in the desktop Trash, which the user deleted, whatever else names it;
`application_state` for application keys in dconf, or a state directory outside shared desktop
locations; `document` for a file named in a window title or selected by the
caller, even if the application holds it open; `application_state` for another
open file outside shared locations; `shared_desktop` for other files in shared
locations; `unrelated` otherwise. A window title names a file only when no
other file name character adjoins the name, so `day.txt` does not match
`today.txt - Notes`.

Application names, which select dconf groups, come from the package, the
executable, the desktop entry's id and `StartupWMClass`, and the window match.
The entry's display name is left out, since a generic name such as `Settings`
would claim other applications' groups.

## Versions and views

Each path lists its versions: the baseline, then its state after each
checkpoint where it, or a database's `-wal` or `-journal` file, changed. A
checkpoint that leaves an absent file absent adds no version. A file's state
at any checkpoint is its last version recorded at or before it, which is how
the [export](desktop-application-export.md#the-seed-checkpoint) and the
[task draft](desktop-application-tasks.md) read it at the seed and end
checkpoints they are given; `capture.checkpoints` lists the names in order.
Views hold the captured bytes as they are, the capture host's name and user
included; the export removes those from the bundle. A version records
whether the file was present, the SHA-256 of its retained bytes, and a view:

| Format    | Detected by                                                            | View                                                                                   |
| --------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `sqlite`  | The `SQLite format 3` header                                           | Every ordinary table's columns, primary key and up to 500 rows                         |
| `dconf`   | The `GVariant` header                                                  | Groups whose path names the application, plus the names of the other groups            |
| `zip`     | A zip local file header, `PK\x03\x04`, whatever the name               | Its file entries in archive order, each with its own format and view                   |
| `json`    | A `.json` name or a leading `{` or `[` that parses                     | The parsed value, from files up to 4 MiB nested up to 500 levels                       |
| `xml`     | An XML name or declaration that parses                                 | An element tree (`name`, `attributes`, `children`); text kept exactly, DTDs never read |
| `keyfile` | Only `[group]`, `key=value` and comment lines, with at least one group | Groups of `key` → string value, from files up to 4 MiB                                 |
| `text`    | Other UTF-8 text                                                       | Lines, up to 5,000                                                                     |
| `binary`  | NUL bytes or invalid UTF-8                                             | None                                                                                   |

A JSON value holding a number JavaScript would round, such as an integer above
2^53, is not read rather than shown rounded.

An XML view names elements and attributes as the document spells them, prefix
included: a saved Inkscape drawing's root is `svg`, in its default namespace,
with `sodipodi:docname` and the declarations `xmlns` and `xmlns:sodipodi`
among its attributes, and a Writer paragraph is `text:p`. An element's
`children` hold its elements and text in order, text split where a CDATA
section, comment or processing instruction falls. Whitespace-only text between
child elements is formatting, and dropped, in an element that holds no other
text, unless `xml:space="preserve"` applies; in mixed content, an element with
text of its own beside its children such as a paragraph split into runs, it is
kept, so `<p>Meet on <s>Sunday</s> <s>evening</s></p>` keeps the space between
the runs. Whitespace here is XML's: space, tab, carriage return and line feed;
a no-break space is text. The view keeps up to 5,000 nodes, comments and
processing instructions counted, nested up to 64 levels, and sets `truncated`
when it leaves some out.

A document that begins with a DOCTYPE naming its DTD, as AbiWord's `.abw`
does, reads as the same element tree, and the view records the declaration
beside `root`, its public identifier normalized as XML matches it:

```json
{
  "doctype": {
    "name": "abiword",
    "public_id": "-//ABISOURCE//DTD AWML 1.0 Strict//EN",
    "system_id": "http://www.abisource.com/awml.dtd"
  },
  "root": { "name": "abiword", "attributes": {}, "children": [] },
  "truncated": false
}
```

An identifier the DOCTYPE leaves out is `null`, and a document without one
has no `doctype`. The DTD is never fetched or read, so it adds no default
attributes and declares no entities. A DOCTYPE with an internal subset
(`<!DOCTYPE a [ … ]>`), which could declare entities, is not read as XML, nor is
a document that refers to any entity but XML's five (`&amp;`, `&lt;`, `&gt;`,
`&apos;`, `&quot;`); such a file is text.

Exported XML views use REA's same formatting-whitespace classification, so
retained XML text and the task checks that address it stay aligned.

SQLite databases are read through REA's SQLite worker from a private copy,
with any retained `-wal` or `-journal` file staged beside it; the worker
accepts an inactive rollback journal and refuses a hot one. A version is not
read when its `-wal` or `-journal` file existed but was not retained, or when
the capture did not record whether either existed, since the database alone
could misstate its committed rows. The capture records them under its content
roots, which include both beside a database selected on its own, when its
baseline walk listed every directory, read every path, entered no other
device, did not stop early and recorded what it left out, and wherever they change; an excluded log, and any elsewhere, is
unknown, since an unchanged file and a missing one look alike. After an
incomplete checkpoint, a database or sidecar without an explicit
later change remains unconfirmed even if a later walk completes. REA does not
combine that older file with a newly recorded member of the SQLite set. The
historical versions remain listed; the affected SQLite view has a `view_error`.
A baseline non-file at a sidecar path, or a non-directory ancestor, cannot
establish an absent file. Captures without the required baseline non-file
inventory must be made again before inspection.
A table
that cannot be read keeps its `error` in place of its rows, and changes to that
database are marked incomplete. dconf
databases are read with `dconf dump /` against a private file profile, so the
live database and the dconf service are not touched; this needs `dconf-cli`, or
`REA_DCONF_COMMAND`.

A version has a `view_error` when its bytes were not retained, are over the 64
MiB read limit, are missing or no longer match their digest, exceed a format's
limit above, or its reader failed.

## Archives

Many applications save a document as a zip archive of XML and other files:
FreeCAD's `.FCStd` and `.FCBak`, OpenDocument (`.odt`, `.ods`, whose
`content.xml` is the document), Office Open XML, EPUB and JAR. Such a file is
`zip`, and its view lists its file entries in archive order, leaving out
directories: an entry whose name ends in `/`, or whose attributes mark a Unix
directory or, from an MS-DOS host, the directory attribute:

```json
{
  "entries": [
    {
      "name": "Document.xml",
      "size": 11923,
      "sha256": "…",
      "format": "xml",
      "view": {
        "root": { "name": "Document", "attributes": {}, "children": [] },
        "truncated": false
      },
      "view_error": null
    }
  ],
  "entry_count": 15,
  "truncated": false
}
```

Each entry's bytes are read from the archive's verified bytes in memory,
checked against its CRC-32 and declared size, and given a `format` and `view`
by the rules and limits above, with the entry's name in place of a file name.
Nothing is extracted to disk. An entry has a `view_error`, with `sha256`,
`format` and `view` null, when it is encrypted, compressed other than stored or
deflated, larger than 16 MiB, more than 100 times its compressed size, past the
64 MiB read from one archive, or its data is damaged. A SQLite or dconf
database, or an archive, inside an archive keeps its format and `sha256` and
has a `view_error` instead of a view: it is not read. The view lists at most
1,000 entries; `entry_count` counts them all, and `truncated` is true when some
are not listed. REA reads the central directory itself, a record at a time,
through the Zip64 end record whenever a Zip64 locator precedes the end record,
as Python's `zipfile` does, and hands the zip reader only the records it lists,
so an archive of hundreds of thousands of entries costs no more to read
than one of a thousand. An archive whose central directory cannot be read has a
`view_error` of its own.

## Kinds of change

Between consecutive versions a change is `created`, `deleted`, or a
format-specific kind with what was added, removed and changed (up to 100 of
each, with counts):

- `lines` for text: lines added and removed, as a multiset.
- `values` for JSON and XML: JSON pointers to values, containers included, so
  an array that becomes an object with the same members is changed. A pointer
  longer than 4096 characters is counted but not listed.
- `values` for zip archives too, with array members named by
  [selectors](desktop-application-tasks.md#pointers-and-selectors) rather than
  positions wherever a selector names one member in both versions: entries by
  name, as `/entries/[name=Document.xml]`, and XML elements by tag and an
  attribute, as `/view/root/children/[name=Object][@name=Hole]`, so an object
  inserted before another does not shift it. A comparison is incomplete when
  either view leaves out entries, or an entry's view is missing or truncated.
- `keys` for key files and dconf: `group/key`, with `~` and `/` in the key
  written `~0` and `~1` as in a JSON pointer, so `[a/b]` `c` and `[a]` `b/c`
  stay apart.
- `rows` for SQLite: `table:` and the row's primary key, or the whole row when
  the table has none.
- `content` for binary files, and `unreadable` when either version has no
  view.
