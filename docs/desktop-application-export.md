# Desktop application export

`rea export-desktop-application <capture-folder> <directory>` turns a folder
written by [desktop application capture](desktop-application-capture.md) into an
agentenv bundle holding one computer app environment: the real application,
installed from the distribution archive on the `ubuntu-24.04` computer base,
launched at boot, seeded with the user's state and serving that state through
agentenv's data operations.

```sh
rea export-desktop-application ./mousepad-capture ./mousepad-bundle
agent-env run ./mousepad-bundle --dry-run
```

The export reads the capture and its [state view](desktop-application-state.md);
it does not run the application. `--name` sets the environment name; otherwise
it comes from the desktop entry id or the program, with an `app-` prefix when
that name would not be a portable bundle name (for example all digits). The
output directory must be new or empty.

The command returns Evidence with operation `export_desktop_application` and
predicate type `rea.desktop-application-export`, listing the environment name,
owned paths, seed files and written files. A failed export, cancellation
included, removes the bundle it had not yet published, so no partial copy of the
user's data remains. If the bundle was published but its output handles could
not be closed, the command reports a cleanup error that carries the export
Evidence; the bundle itself is complete.

## The bundle

| Path                    | Contents                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `envs/<name>/env.toml`  | `type = "computer_app"`, the module and class, `computer = "ubuntu-24.04"`, `driver = "reference"` |
| `envs/<name>/<file>.py` | The `ComputerAppEnvironment` class                                                                 |
| `envs/<name>/SKILL.md`  | What the app is, its window class and where its files live                                         |
| `envs/<name>/seed/`     | The application's files from before the capture, by home-relative path                             |
| `tasks/smoke.json`      | A task that deploys the app                                                                        |
| `README.md`             | What was exported, from which capture, and what to keep in mind                                    |

The class file is `<name>_app.py` with hyphens as underscores, for example
`mousepad_app.py`: agentenv imports it under its stem, so a plain `<name>.py`
could shadow a standard library module such as `calendar`. A class name that
would collide with a name the module imports or defines, such as `Path`, takes
an `App` suffix.

The class declares:

- `Packages(apt=[...])` with the package the capture found. The export refuses
  applications not installed from the Ubuntu 24.04 archive or a mirror of it
  (local `.deb`, a PPA or other third-party repository, snap, flatpak,
  AppImage), since the computer could not install them by name. A source counts
  when apt reports its origin as `Ubuntu` for a noble suite; a capture made
  before origins were recorded counts only Canonical's own archive hosts.
- A launch at boot with the captured command, ready when a window of the
  captured class appears. Arguments that are the captured home or under it, and
  `<option>=<path>` values under it, are respelled under the computer user's
  `$HOME`. agentenv starts the app in its own folder, so when an argument is
  relative the command first changes to the captured working directory
  (`"$HOME"` when that was the home), and still starts if that folder is
  missing. The export refuses a capture that saw no application window.
- `paths`: the state directories holding the application's state files and the
  folders holding its documents, nested folders collapsed. The home itself and
  the shared `.config`, `.local`, `.local/share`, `.local/state` and `.cache`
  folders are never owned whole: a file directly in one is owned as itself.
  Files the capture recorded under a symlinked state directory's physical
  spelling are mapped back to the state directory's home spelling.
- Data hooks, because declaring any hook switches off agentenv's default data
  plane: the class seeds the home once per boot and keeps it as the initial
  state with `keep_initial`, `data/add` and `data/reset` call agentenv's `add`
  and `reset`, and `data/get` returns the files under `paths` plus a data part
  with a typed JSON view of each, read in a worker thread. An application with
  no observed state declares no paths and no hooks.

Seeded text files (text, JSON, key files and XML in the state view) have the
captured home path respelled to the computer's home wherever it is followed by
`/`, the end of the text, or a character that cannot continue a file name;
other files are copied as captured. A file under the owned paths whose starting
bytes the capture did not retain is not seeded: one in the state view without
retained baseline content, or one the capture omitted (for example too large
or past the content budget). The result lists them in `unseeded_files` and the
README names them. When the application held files open in folders whose
starting content the capture did not retain, a limitation names those folders.

The application's dconf keys at the baseline, if any, are written once when the
app first starts, also for an application that owns no files, and the class adds
`dconf-cli` to its apt packages for that. The server starts before the
desktop's D-Bus session, so the class does not use `dconf load`: it dumps any
existing user database through a `file-db:` profile, then runs `dconf compile`
on that dump and the captured keys, in that name order so the captured keys
win, and replaces `~/.config/dconf/user`. If that fails, the server prints a
one-line warning and the app starts without the captured keys. `data/reset` does
not restore them.

## Typed views

The views follow the [state view](desktop-application-state.md)'s formats and
shapes: SQLite tables (at most 64 ordinary tables, `tables_truncated` past
that, and per table `columns`, `primary_key`, at most 500 `rows` and
`truncated`, with blobs, unsafe integers and text that is not UTF-8 tagged as
REA tags them), JSON, XML as `{root, truncated}` with DOCTYPEs refused and REA's
node, depth and whitespace rules, key file groups, and text as
`{lines, line_count, truncated}` split on `\n` and `\r\n`. Format detection
follows REA's rules. Files larger than 64 MiB get an `error` instead of a view
and are not read. Known differences remain:

- XML names: element and attribute names are Python's `{namespace}local`
  spelling rather than REA's prefixed names, namespace declarations are not
  listed as attributes, and CDATA sections merge with the text around them, so
  they count as one node.
- dconf databases are reported as binary, since REA reads them with `dconf`.
- SQLite databases are read in place, read-only, rather than from a staged copy;
  a table or column name that is not UTF-8 gives the file an `error`.
- JSON integers beyond 2^53 keep their exact value, and nesting deeper than
  Python's recursion limit gives the file an `error`.

The seed is the user's real data. Keep the bundle local and do not publish it.
The class was checked against agentenv-framework 0.9.1431 with
`python -m agentenv_protocol.computer._declare` and `agent-env run --dry-run`.
