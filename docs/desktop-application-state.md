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

The role follows from the reasons, in this order: `application_state` for
application keys in dconf, or a state directory outside shared desktop
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
checkpoint that leaves an absent file absent adds no version. A version records
whether the file was present, the SHA-256 of its retained bytes, and a view:

| Format    | Detected by                                                            | View                                                                                    |
| --------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `sqlite`  | The `SQLite format 3` header                                           | Every ordinary table's columns, primary key and up to 500 rows                          |
| `dconf`   | The `GVariant` header                                                  | Groups whose path names the application, plus the names of the other groups             |
| `json`    | A `.json` name or a leading `{` or `[` that parses                     | The parsed value, from files up to 4 MiB nested up to 500 levels                        |
| `xml`     | An XML name or declaration that parses                                 | An element tree (`name`, `attributes`, `children`); text kept exactly, DOCTYPEs refused |
| `keyfile` | Only `[group]`, `key=value` and comment lines, with at least one group | Groups of `key` → string value, from files up to 4 MiB                                  |
| `text`    | Other UTF-8 text                                                       | Lines, up to 5,000                                                                      |
| `binary`  | NUL bytes or invalid UTF-8                                             | None                                                                                    |

A JSON value holding a number JavaScript would round, such as an integer above
2^53, is not read rather than shown rounded.

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
unknown, since an unchanged file and a missing one look alike. A table
that cannot be read keeps its `error` in place of its rows, and changes to that
database are marked incomplete. dconf
databases are read with `dconf dump /` against a private file profile, so the
live database and the dconf service are not touched; this needs `dconf-cli`, or
`REA_DCONF_COMMAND`.

A version has a `view_error` when its bytes were not retained, are over the 64
MiB read limit, are missing or no longer match their digest, exceed a format's
limit above, or its reader failed.

## Kinds of change

Between consecutive versions a change is `created`, `deleted`, or a
format-specific kind with what was added, removed and changed (up to 100 of
each, with counts):

- `lines` for text: lines added and removed, as a multiset.
- `values` for JSON and XML: JSON pointers to values, containers included, so
  an array that becomes an object with the same members is changed. A pointer
  longer than 4096 characters is counted but not listed.
- `keys` for key files and dconf: `group/key`, with `~` and `/` in the key
  written `~0` and `~1` as in a JSON pointer, so `[a/b]` `c` and `[a]` `b/c`
  stay apart.
- `rows` for SQLite: `table:` and the row's primary key, or the whole row when
  the table has none.
- `content` for binary files, and `unreadable` when either version has no
  view.
