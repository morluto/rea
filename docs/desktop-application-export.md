# Desktop application export

`rea export-desktop-application <capture-folder> <directory>` turns a folder
written by [desktop application capture](desktop-application-capture.md) into an
agentenv bundle holding one computer app environment: the real application,
installed from the distribution archive, its vendor's apt repository or the
`.deb` file it was installed from on the `ubuntu-24.04` computer base, launched
at boot, seeded with the user's state and serving that state through agentenv's
data operations.

```sh
rea export-desktop-application ./mousepad-capture ./mousepad-bundle
agent-env run ./mousepad-bundle --dry-run
```

The export reads the capture and its [state view](desktop-application-state.md);
it does not run the application. `--name` sets the environment name; otherwise
it comes from the desktop entry id or the program, with an `app-` prefix when
that name would not be a portable bundle name (for example all digits). The
output directory must be new or empty. `--task` adds a task an agent wrote for
the capture, once REA has validated it against the capture; see
[desktop application tasks](desktop-application-tasks.md). `--package-url`
says where the computer downloads the package of an application installed from
a `.deb` file; see [Applications from a .deb file](#applications-from-a-deb-file).

The command returns Evidence with operation `export_desktop_application` and
predicate type `rea.desktop-application-export`, listing the environment name,
owned paths, seed files and written files. A failed export, cancellation
included, removes the bundle it had not yet published, so no partial copy of the
user's data remains. If the bundle was published but its output handles could
not be closed, the command reports a cleanup error that carries the export
Evidence; the bundle itself is complete.

## The bundle

| Path                             | Contents                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `envs/<name>/env.toml`           | `type = "computer_app"`, the module and class, `computer = "ubuntu-24.04"`, `driver = "reference"` |
| `envs/<name>/<file>.py`          | The `ComputerAppEnvironment` class                                                                 |
| `envs/<name>/SKILL.md`           | What the app is, its window class and where its files live                                         |
| `envs/<name>/seed/`              | The application's files from before the capture, by home-relative path                             |
| `envs/<name>/apt-keys/`          | The signing key of each vendor apt repository the app installs from                                |
| `envs/<name>/install-package.sh` | With `--package-url`: the run script that installs the downloaded package with dpkg                |
| `tasks/smoke.json`               | A task that deploys the app                                                                        |
| `tasks/<task>.json`              | With `--task`: the agent's task, its verifier in `artifacts/` and the eval in `evals/`             |
| `README.md`                      | What was exported, from which capture, and what to keep in mind                                    |

The class file is `<name>_app.py` with hyphens as underscores, for example
`mousepad_app.py`: agentenv imports it under its stem, so a plain `<name>.py`
could shadow a standard library module such as `calendar`. A class name that
would collide with a name the module imports or defines, such as `Path`, takes
an `App` suffix.

The class declares:

- `Packages(apt=[...])` with the package the capture found. A vendor package
  is named `<package>/<release>`, its repository's release (the Suite apt
  reports as `a=`, or else its Codename), so apt takes it from that repository
  even when the Ubuntu archive offers a higher version or epoch, as noble's
  transitional `firefox` does over packages.mozilla.org's; it is named alone
  when the release names neither. Its library packages follow, so a package
  that leaves out dependencies on the libraries it loads, as Typora's Electron
  package does, still starts; library packages the capture found neither the
  Ubuntu 24.04 archive nor a declared repository offers are left out, with a
  limitation. An archive package's declared dependencies are trusted as they
  are. The package must come from the Ubuntu 24.04 archive or a mirror of it,
  or from a vendor apt repository whose signing key the capture verified and
  retained. A source counts as the archive when apt reports its origin as
  `Ubuntu` for a noble suite; a capture made before origins were recorded
  counts only Canonical's own archive hosts.
- For a vendor repository, `sources=[AptSource(apt=..., suite=...,
  components=[...], key="apt-keys/<name>.gpg")]`, with the retained key copied
  to that path (`.asc` when it is armored, which agentenv tells by its
  content). apt takes one key per URI and suite, so sources that share them,
  such as one repository listed for two architectures, are declared once, with
  their components merged; one with a different key is left out. A repository
  whose key the capture did not verify, an Ubuntu Pro (ESM) repository, one
  not reached over http or https, or one whose `arch=` restriction leaves out
  the capture host's architecture is refused with its reason; when another
  usable repository lists the same version it is left out instead, with a
  limitation. The export also refuses snaps, flatpaks, AppImages, and a
  package no recorded repository lists unless it was installed from a `.deb`
  file the capture recorded and `--package-url` is given, since the computer
  could not install them by name.
- `@computer_app(supports=...)` with both `amd64` and `arm64` for an archive
  package, which the archive serves for both, and only the capture host's
  architecture for a vendor package, since its repository may serve no other.
  A vendor package captured on any other architecture is refused. A package
  installed from its `.deb` file supports only that file's architecture.
- A launch at boot with the captured command, ready when a window of the
  captured class appears. Arguments that are the captured home or under it, and
  `<option>=<path>` values under it, are respelled under the computer user's
  `$HOME`. agentenv starts the app in its own folder, so when an argument is
  relative the command first changes to the captured working directory
  (`"$HOME"` when that was the home), and still starts if that folder is
  missing. The export refuses a capture that saw no application window.
- For an Electron application (the capture found its fuse sentinel or a
  `resources/app.asar`), `--no-sandbox` right after the program unless the
  command already has it: Chromium's sandbox needs user namespaces the
  computer's container does not grant, and Electron exits without them. The
  README and the result's limitations say the sandbox is off.
- `paths`: the state directories holding the application's state files and the
  folders holding its documents, nested folders collapsed. The home itself and
  the shared `.config`, `.local`, `.local/share`, `.local/state` and `.cache`
  folders are never owned whole: a file directly in one is owned as itself.
  Files the capture recorded under a symlinked state directory's physical
  spelling are mapped back to the innermost such directory's home spelling,
  unless that spelling is outside the captured home, as when the home itself is
  a symbolic link. When two files map to one home path, the export uses the one
  present before the capture, else the first by path, and a limitation names
  the other.
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

## Applications from a .deb file

A closed-source application you installed from a `.deb` file you downloaded,
such as VariCAD from varicad.com, is not in any apt repository the computer can
use. Capture it with `--package-file` naming that file (see
[desktop application capture](desktop-application-capture.md)), then pass
`--package-url` to the export with an `http://` or `https://` URL the computer
can download that same file from:

```sh
rea capture-desktop-application --executable varicad --package-file ~/Downloads/varicad2026-en_2.03_amd64.deb --output ./varicad-capture
rea export-desktop-application ./varicad-capture ./varicad-bundle --package-url https://files.example.com/varicad2026-en_2.03_amd64.deb
```

The class then declares, beside `Packages`:

- `downloads=[Download(url=..., sha256=..., to="vendor/<file>", arch=...)]`
  with the captured file's SHA-256. agentenv downloads the URL once, when the
  bundle is put, and refuses the file unless its SHA-256 matches, so the
  computer installs exactly the captured version. The bundle does not contain
  the package.
- `Packages(apt=[...])` with the first alternative of each of the file's
  Depends and Pre-Depends entries, without version constraints or `:any`
  qualifiers, then the library packages the capture found, since a vendor's
  binary may load libraries its Depends leaves out.
- `run=[RunScript(script="install-package.sh")]`, a script the export writes
  into the environment folder. agentenv runs it as root from the app's folder
  once the apt packages are installed and the download is in place, with the
  network off: it runs `dpkg -i` on the download and then removes it.

The bundle supports only the file's architecture. Vendor sites often refuse
automated downloads, as varicad.com does, so the URL may need to point at a
copy you keep, such as a private mirror; you must be allowed to use that copy,
and the package's licence, such as a 30-day trial's terms, is yours to check.
The README and the result's limitations say so.

The export refuses a package no recorded repository lists when `--package-url`
is missing, saying to capture with `--package-file` if the capture lacks it. It
also refuses `--package-url` when the capture recorded no package file, giving
the capture's `package_file_reason` when there is one; when the archive or a
declared vendor repository installs the package already; when the URL is not
written as `http://` or `https://` or holds a user name or password; and when
the file is built for an architecture other than `amd64`, `arm64` or `all`.

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
  a write lock the running app holds is waited out for a quarter of a second
  and then gives the file an `error`, and so does a table or column name that
  is not UTF-8.
- JSON integers beyond 2^53 keep their exact value, and nesting deeper than
  Python's recursion limit gives the file an `error`.

The seed is the user's real data. Keep the bundle local and do not publish it.
The class was checked against agentenv-framework 0.9.1431 with
`python -m agentenv_protocol.computer._declare` and `agent-env run --dry-run`.
