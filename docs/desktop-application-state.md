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

| Reason                   | Meaning                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `state_directory`        | It lies in one of the application's state directories                    |
| `opened_by_application`  | An application process held it open during a sample                      |
| `named_in_window_title`  | An application window title spelled its name or `~/` path                |
| `selected_path`          | It lies under a `--state-path` or absolute `--argument` of the capture   |
| `dconf_application_keys` | It is a dconf database holding groups whose path names the application   |
| `desktop_service`        | It lies where desktop services and toolkits keep shared files, or caches |

The role follows from the reasons: `application_state` for application keys in
dconf, or a state directory or open file outside shared desktop locations;
`document` for a file named in a window title or selected by the caller;
`shared_desktop` for other files in shared locations; `unrelated` otherwise.
Application names come from the package, executable, desktop entry and window
match.

## Versions and views

Each path lists its versions: the baseline, then its state after each
checkpoint where it changed. A version records whether the file was present,
the SHA-256 of its retained bytes, and a view:

| Format    | Detected by                                        | View                                                                        |
| --------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| `sqlite`  | The `SQLite format 3` header                       | Every ordinary table's columns, primary key and up to 500 rows              |
| `dconf`   | The `GVariant` header                              | Groups whose path names the application, plus the names of the other groups |
| `json`    | A `.json` name or a leading `{` or `[` that parses | The parsed value                                                            |
| `xml`     | An XML name or declaration that parses             | An element tree (`name`, `attributes`, `children`); DOCTYPEs are refused    |
| `keyfile` | An INI-style name or a `[group]` line              | Groups of `key` → string value                                              |
| `text`    | Other UTF-8 text                                   | Lines, up to 5,000                                                          |
| `binary`  | NUL bytes or invalid UTF-8                         | None                                                                        |

SQLite databases are read through REA's SQLite worker from a private copy,
with a retained `-wal` file staged beside it. dconf databases are read with
`dconf dump /` against a private file profile, so the live database and the
dconf service are not touched; this needs `dconf-cli`, or `REA_DCONF_COMMAND`.
A version without retained bytes, or whose reader failed, has a `view_error`.

## Kinds of change

Between consecutive versions a change is `created`, `deleted`, or a
format-specific kind with what was added, removed and changed (up to 100 of
each, with counts):

- `lines` for text: lines added and removed, as a multiset.
- `values` for JSON and XML: JSON pointers to leaves.
- `keys` for key files and dconf: `group/key`.
- `rows` for SQLite: `table:` and the row's primary key, or the whole row when
  the table has none.
- `content` for binary files, and `unreadable` when either version has no
  view.
