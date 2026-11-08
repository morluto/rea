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
`--seed-checkpoint` names the checkpoint whose state seeds the bundle, the
baseline by default, and `--end-checkpoint` the one a task must pass on, the
capture's last by default; see [The seed checkpoint](#the-seed-checkpoint).

The command returns Evidence with operation `export_desktop_application` and
predicate type `rea.desktop-application-export`, listing the environment name,
the seed and end `checkpoints`, owned paths, seed files, the seeds it
rewrote to remove the capture host's name and user (`scrubbed_files`), the
bundle files that still hold them (`unscrubbed_files`), and written files,
the last three by their path in the bundle. A failed export, cancellation
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
| `envs/<name>/seed/`              | The application's files at the seed checkpoint, by home-relative path                              |
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

Captured titles and checkpoint labels keep their original text in Python
documentation strings. The skill's YAML description likewise quotes the title
and window class, so punctuation and control characters do not change its value
or break the generated module.

The class declares:

- `Packages(apt=[...])` with the package the capture found. A vendor package
  is named `<package>/<release>`, its repository's release (the Suite apt
  reports as `a=`, or else its Codename), so apt takes it from that repository
  even when the Ubuntu archive offers a higher version or epoch, as noble's
  transitional `firefox` does over packages.mozilla.org's; it is named alone
  when the release names neither, or when the capture was written before
  releases were recorded. Its library packages follow, so a package that
  leaves out dependencies on the libraries it loads, as Typora's Electron
  package does, still starts; library packages the capture found neither the
  Ubuntu 24.04 archive nor a declared repository offers are left out, with a
  limitation, and so are those only repositories the export leaves out supply
  (a repository's `supplies`), such as one whose key the capture could not
  retain. An archive package's declared dependencies are trusted as they
  are. When the desktop entry's package is not the one that owns the program
  it runs, as `vim-common`'s entry runs `vim`'s program, the program's package
  (`executable_package`) follows the app's by name, since the entry's package
  need not depend on it; a capture that found no archive or declared
  repository offering it records why, and the export refuses it with that
  reason, as it does when only repositories it leaves out supply it, or when
  no package owns the program at all (`executable_package_reason` without
  `executable_package`). The package must come from the Ubuntu 24.04 archive
  or a mirror of it,
  or from a vendor apt repository whose signing key the capture verified and
  retained. A source counts as the archive when apt reports its origin as
  `Ubuntu` for a noble suite; a capture made before origins were recorded
  counts only Canonical's own archive hosts.
- For a vendor repository, `sources=[AptSource(apt=..., suite=...,
  components=[...], key="apt-keys/<name>.gpg")]`, with the retained key copied
  to that path (`.asc` when it is armored, which agentenv tells by its
  content). A PPA added with `add-apt-repository`, whose sources entry holds its
  key in `Signed-By`, exports that key as `apt-keys/<name>.asc`. apt takes one
  key per URI and suite, so sources that share them, such as one repository
  listed for two architectures, are declared once, with their components
  merged; one with a different key is left out. A repository
  whose key the capture did not verify, an Ubuntu Pro (ESM) repository, one
  whose sources entry's URI held a user name or password (which the capture
  did not record and the export never writes; the reason names neither them
  nor the URI), one not reached over http or https, or one whose `arch=`
  restriction leaves out the capture host's architecture is refused with its
  reason (a capture
  written before restrictions were recorded counts as unrestricted); when
  another usable repository lists the same version it is left out instead,
  with a limitation. The export also refuses snaps, flatpaks, AppImages, and a
  package no recorded repository lists unless it was installed from a `.deb`
  file the capture recorded and `--package-url` is given, since the computer
  could not install them by name, and a capture written before credentials
  were removed whose repository URI still holds them, since it counted that
  repository's libraries as installable; capture it again.
- `@computer_app(supports=...)` with both `amd64` and `arm64` for an archive
  package, which the archive serves for both, and only the capture host's
  architecture for a vendor package, since its repository may serve no other.
  A vendor package captured on any other architecture is refused. A package
  installed from its `.deb` file supports only that file's architecture.
- A launch at boot with the captured command, ready when a window of the
  captured class appears and one of them is listed in the taskbar and is not
  typed as a splash: a splash screen or a dialog of the class skips the
  taskbar or says it is a splash, and an app whose splash shows first would
  otherwise count as ready before its own window opens. Arguments that are the captured home or under it, and
  `<option>=<path>` values under it, are respelled under the computer user's
  `$HOME`. agentenv starts the app in its own folder, where an open or save
  dialog would show the framework's files, so the command first changes to the
  captured working directory (`"$HOME"` when that was the home, as for a
  desktop entry without `Path`), which a relative argument or program path
  such as `./app` also needs, and still starts if that folder is missing. The
  export refuses a capture that saw no application window.
- For an Electron application (the capture found its fuse sentinel or a
  `resources/app.asar`), `--no-sandbox` right after the program unless the
  command already has it: Chromium's sandbox needs user namespaces the
  computer's container does not grant, and Electron exits without them. The
  README and the result's limitations say the sandbox is off.
- `paths`: the state directories holding the application's state files and the
  folders holding its documents, nested folders collapsed. A folder beside a
  state directory whose name differs from it only in letter case is owned
  whole in the files' spelling, so a `~/.config/GIMP` profile GIMP created
  during the capture beside the candidate `~/.config/gimp` is owned as
  `.config/GIMP`, not as the folder of its first file. The home itself and
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

A file under the owned paths whose bytes at the seed the capture did not
retain is not seeded: one in the state view without retained content at that
checkpoint, or one the capture omitted (for example too large or past the
content budget). The result lists them in `unseeded_files` and the README
names them. When the application held files open in folders whose starting
content the capture did not retain, a limitation names those folders. The
desktop Trash, `~/.local/share/Trash`, is never the application's, so a file
the user moved there is neither owned nor seeded, even when a window title
names it; a limitation lists the files the Trash held at the seed.

The application's dconf keys at the seed, if any, are written once when the
app first starts, also for an application that owns no files, and the class adds
`dconf-cli` to its apt packages for that. The server starts before the
desktop's D-Bus session, so the class does not use `dconf load`: it dumps any
existing user database through a `file-db:` profile, then runs `dconf compile`
on that dump and the captured keys, in that name order so the captured keys
win, and replaces `~/.config/dconf/user`. If that fails, the server prints a
one-line warning and the app starts without the captured keys. `data/reset` does
not restore them.

## The seed checkpoint

By default the seed is the state before the capture, its `baseline`, and a
task's end state is the capture's last checkpoint. `--seed-checkpoint` and
`--end-checkpoint` name others, so one capture can make a seed and then a
change: the user creates and saves a document and takes `checkpoint seed`,
then edits and saves it and takes `checkpoint end`. Exported with
`--seed-checkpoint seed --end-checkpoint end`, the bundle seeds the document
as it was saved at `seed`, owned paths, dconf keys and unseeded files
included, and a task must fail on that seed and pass on the state at `end`.
A file's state at a checkpoint is its last version recorded at or before it.
The export refuses a name the capture does not hold exactly once, and an end
checkpoint taken before the seed checkpoint; `inspect-desktop-application-state`
lists the names in `capture.checkpoints`.

## Host name and user

A seed can hold the capture host's name and the user's: Geany saved its mail
template as `pref_template_mail=ada@e81232be457d`, the user `ada` on a
container named `e81232be457d`, and many files hold the home path
`/home/ada`. The capture records `host.hostname` and `host.user`, and the
export removes them from what the bundle ships:

- In seeded text files (text, JSON, key files and XML in the state view), in
  UTF-16 files that start with a byte-order mark (keeping the mark, byte order
  and a following U+FEFF content character), and in the dconf keys,
  `user@host` becomes `user@localhost`, the
  host name standing alone becomes `localhost`, and the captured home becomes
  `/home/user` wherever it is followed by `/`, the end of the text, or a
  character that cannot continue a file name. The host name counts only as a
  whole name: not inside a longer word, before a `-`, or as a label of a
  domain such as `e81232be457d.local`, so a host named `ubuntu` leaves
  `ports.ubuntu.com/ubuntu-ports` alone. A host named `localhost` is left
  alone, but its `user@localhost` still takes the computer's user. The user
  name alone is never replaced, since a short one such as `ada` or `user` is
  also ordinary text. A rewritten seed is written with its own SHA-256, and
  `scrubbed_files` and the README list it.
- JSON and XML keep their syntax. In JSON only string values change, each
  read as its decoded value, so `\u0065` escapes cannot hide the host, and is
  written back as JSON only when it changed; numbers and `true`, `false` and
  `null` stay as they are even for a host named `true`. Member names are never
  rewritten, since `{"ubuntu": 1, "localhost": 2}` on a host named `ubuntu`
  would get two `localhost` keys and lose a setting; a file whose names hold
  the host is listed in `unscrubbed_files` instead. In XML only character
  data, attribute values, comments and CDATA change, character references
  decoded the same way; element and attribute names and processing
  instructions stay. A UTF-16 file is scrubbed by the format its text would
  have in UTF-8, so JSON or XML in UTF-16 follows these rules too.
- In the dconf keys only GVariant strings change, each read as its decoded
  value and written back in its own quotes only when it changed. Group names,
  keys, dictionary keys, bytestrings and everything outside quotes stay, so a
  host named `true` leaves `wrap=true` alone. A value whose string does not
  parse, or that holds an object path or signature, ships as captured.
- `SEED_HOME` in the class is `/home/user`, the home the seed spells, which
  the class respells to the computer's own home when it seeds the home at
  boot, as it did the captured home before. The replacements read as the
  computer's own: its user is `user`, with its home in `/home/user`, and
  `localhost` is the name every host has for itself.
- Binary files, SQLite databases among them, and text files over 256 MiB are
  copied as captured. Then every file the bundle ships, the class module with
  its dconf keys and the README included, is searched by a looser rule than
  the replacement's: the host name and `user@host` anywhere, as in
  `e81232be457d.local` or a seed named `e81232be457d-notes.txt`, and the
  captured home as a whole path, in its path and its content, JSON and dconf
  strings and XML references decoded and the replacements themselves set
  aside. Each one found is listed in `unscrubbed_files`, and in the README
  unless it is the README, to check before sharing the bundle. Bytes that are not text are
  searched as they are, so a binary file that holds the host in another
  encoding is not listed.
- A task check whose values name `user@host` or the host name anywhere, by
  that rule, is refused, as one naming the captured home is: the bundle does
  not hold them. Its field names, kind and id are not values, so a host named
  `file` or `kind` refuses no check. A task's checks must fail on the seed as
  the bundle ships it, scrubbed, so a check the scrub itself satisfies, such
  as a mail setting the user changed from `ada@e81232be457d` to
  `user@localhost`, does not count as failing there.

A capture written before the host's name and user were recorded has only its
home removed, with a limitation saying so; capture again to remove the rest.

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
REA tags them), JSON, XML as `{root, truncated}` with REA's node, depth and
whitespace rules and its `doctype` when the document declares one, key file
groups, text as
`{lines, line_count, truncated}` split on `\n` and `\r\n`, and zip archives
as their entries, read with Python's `zipfile` from the file in place, with
REA's entry, size, compression ratio and archive limits and its wording for an
entry it does not read. The module reads the central directory itself, as REA
does, and shows `zipfile` only the records it lists, reading each entry in
bounded chunks no further than a byte past its declared size. A JSON file
holding a number JavaScript cannot read exactly, such as an integer above 2^53,
or whose retained value nests more than 500 levels deep, gets an `error` instead of a view, as in
REA. Duplicate keys keep their last value before the depth check. Text that is not one JSON
document, such as JSON Lines, stays text. Format detection follows REA's
rules. Files larger than 64 MiB get an `error` instead of a view
and are not read. XML is read with Python's `expat` twice: with namespace
processing, which refuses what REA's parser refuses, such as an undeclared
prefix, then without it, so element and attribute names keep the prefixes the
document spells and namespace declarations stay attributes, as in REA's view;
text splits into nodes where REA's splits it, at CDATA sections, comments and
processing instructions. Both passes read a DOCTYPE as REA does: with
parameter entity parsing off, so the DTD it names is never read, and handlers
that refuse an internal subset, an external entity and an entity expat would
skip; the first pass also checks each start tag for a reference to an
undeclared entity, which expat drops from an attribute value without a word
when a DOCTYPE names a DTD. Known differences remain:

- dconf databases are reported as binary, since REA reads them with `dconf`;
  inside an archive, one is `dconf` with an error, as in REA.
- Zip entry names: a name in an Info-ZIP Unicode Path extra field is used only
  where Python's `zipfile` reads it (3.12 and later), and an entry whose local
  header names it differently from the central directory is damaged rather
  than read.
- SQLite databases are read in place, read-only, rather than from a staged copy;
  a write lock the running app holds is waited out for a quarter of a second
  and then gives the file an `error`, and so does a table or column name that
  is not UTF-8.

The seed is the user's real data. Keep the bundle local and do not publish it.
The class was checked against agentenv-framework 0.9.1431 with
`python -m agentenv_protocol.computer._declare` and `agent-env run --dry-run`.
