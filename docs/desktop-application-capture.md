# Desktop application capture

`rea capture-desktop-application` launches an installed Linux desktop
application, watches it while a person or a driver uses it, and records what
it is, which windows it opened and how the files under the home directory
changed. The result is the starting point for turning the application into an
agent environment: the inventory says how to install and launch it, the windows
say how to recognise it, and the checkpoints hold the state it read and wrote.

The application runs with the current user's permissions, in the current
desktop session, against the user's real files. This is not a sandbox. The
capture folder keeps copies of real files from the home directory, so treat it
as private data and keep it local.

## Host support

Capture runs on Linux with an X11 display: `DISPLAY` must be set, and `xprop`
(from `x11-utils`) must be installed, or `REA_XPROP_COMMAND` must name it.
The window manager must support the EWMH client list (`_NET_CLIENT_LIST`,
listed in `_NET_SUPPORTED`), as xfwm4, Mutter, KWin and Openbox do; without it
the capture is refused, because no window could be seen. A supported list that
is unset, as xfwm4 leaves it while no window is open, means no windows. Applications that run under XWayland are visible;
native Wayland windows are not. Other hosts are refused before anything is
launched.

## Capture an application

Name the application by its desktop entry id, the entry's absolute path, or an
executable:

```sh
rea capture-desktop-application --desktop-entry org.xfce.mousepad --output ./mousepad-capture
rea capture-desktop-application --executable gnucash --argument /home/ada/books.gnucash --output ./gnucash-capture
```

Desktop entries are looked up in `$XDG_DATA_HOME/applications` and then each
`$XDG_DATA_DIRS` directory; an entry installed as a symbolic link, as flatpak
and Nix do, is followed to its file. The entry's `Exec` line is expanded with no files;
`--argument` values are appended in its place, and the application runs in the
entry's `Path` or the home directory. When the line starts with
`env NAME=value`, the program is found on the `PATH` those assignments set,
with an empty or relative entry read from the folder the application runs
in, and their XDG folders name the state directories. Otherwise the program is
looked up on the host's `PATH` in the order the launch searches it, and one
found only through a relative or empty entry is refused, since the exported
computer would not have that entry. An `--executable` runs from
the current directory, as it would from a shell, and a relative path to it is
resolved there.

Before writing anything the command refuses to start if a window of the
application is already open, or if the window list cannot be read. A launch
beside a running instance can hand off to it, and that instance's unsaved
state would be missing from the baseline. It then records the starting state,
launches the application in its own process group with a run token in its
environment, and reads commands from stdin, one per line. The application gets
REA's environment without the `AGENTENV_*` variables an agent environment sets,
such as its control token: an app the exported computer launches never has
them, and an app captured inside a computer must not hold a credential to it.

| Line                                        | Effect                                                      |
| ------------------------------------------- | ----------------------------------------------------------- |
| empty, `checkpoint`, or `checkpoint <name>` | Record the current state as a checkpoint                    |
| any other text except `stop`                | Record a checkpoint named by that text                      |
| `stop`, or the end of stdin                 | Record a final checkpoint, close the application and finish |

An unnamed checkpoint is named `checkpoint-<ms>` after its time in the
session. A name that repeats an earlier checkpoint, or is one of the capture's
own names (`baseline`, `stop`, `time-limit`, `exit`), is refused with a
progress line on stderr; no checkpoint is taken and the session continues.

Name the checkpoints a later step reads by what they mark. The
[export](desktop-application-export.md) seeds the bundle from the baseline
unless `--seed-checkpoint` names another, and a
[task](desktop-application-tasks.md) is checked against the last checkpoint
unless `--end-checkpoint` names another. So one capture can build a seed and
then the change: launch the app, create and save the document, send
`checkpoint seed`, make the edit and save it, send `checkpoint end`, then
`stop`.

The session also finishes when the launched process has exited and the
application's processes and windows are all gone in two consecutive samples,
or when `--max-duration-seconds` passes. Before deciding the processes are
gone, the capture looks for any process still carrying the run token, so a
worker whose launcher exited before it was sampled keeps the session open. A
sample whose window list could not be read is not taken as an empty one; the
limitations say how many there were. One queued line is handled between
samples, and reading stdin pauses while 16 lines wait. Progress lines on stderr say when
the window has opened and when each checkpoint is taken.

When the session ends the capture sends SIGTERM to the launched process, its
process group and every process that carries the run token, waits up to five
seconds for them to exit, and then removes every process that still carries
the token, whether or not it stayed in the process group. If that cleanup
cannot be verified after a second attempt, the capture is still written, and
the command then fails, naming the run token and process group that may
remain. Interrupting the command (Ctrl-C) ends the session the same way
without a further checkpoint; the capture is still written with end reason
`cancelled`, and the command exits with status 130. Interrupted before the
application is launched, the command writes no capture and removes the
content it had retained.

If the capture fails for any other reason before `capture.json` is written,
the application is closed the same way and the content already retained is
removed from the capture folder. The error names any process or file that
could not be removed.

A person types these lines in the terminal. An agent can drive the
application with a tool such as `xdotool` and write the lines to a FIFO that
it passes as stdin. Because the end of stdin stops the session, the driver
must keep the FIFO open for writing between checkpoints, for example with
`exec 3>capture.fifo` in a shell, rather than open and close it for each
line.

| Option                   | Default | Meaning                                                                                   |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| `--state-path`           | none    | File or directory whose starting content is retained too (repeatable)                     |
| `--exclude`              | none    | Path left out of every checkpoint walk (repeatable); the output folder is always left out |
| `--max-duration-seconds` | 3600    | Stop the session after this long                                                          |
| `--max-entries`          | 250,000 | Paths recorded per checkpoint walk, its roots included                                    |
| `--max-file-bytes`       | 64 MiB  | Largest file whose content is retained                                                    |
| `--max-content-bytes`    | 1 GiB   | Total retained content                                                                    |
| `--package-file`         | none    | The `.deb` file the application was installed from; its facts are recorded, not the file  |

`--state-path`, `--exclude` and `--output` refuse an empty value, which
would otherwise name the current directory.

## The capture folder

The output folder must be new, or empty and owned by the current user; the
command makes it private (mode 0700). It holds:

- `capture.json`: the Evidence record, also printed on stdout.
- `content/<sha256>`: the bytes of each retained file, stored once per
  distinct content.

The Evidence operation is `capture_desktop_application` and its predicate type
is `rea.desktop-application-capture`. Its `host` names the platform,
architecture, display and home directory, and the host's name (`hostname`)
and the user's (`user`), which captured state can hold, as in a mail
template's `ada@e81232be457d`; the export removes them from the bundle. A
capture written before they were recorded has neither, and one is left out
when the system cannot say, as for a user with no passwd entry. The rest of
the result has four parts.

**Application.** The desktop entry (id, path, name, `Exec`, icon,
`StartupWMClass`, categories, MIME types), the launch command and working
directory, the executable as found on `PATH` and after resolving links, and the
package that installed it. A Debian package records its name, version,
architecture and the apt sources that list the installed version, with the
origin (`o=`) apt reports for each source in `source_origins`, such as `Ubuntu`
for the Ubuntu archive and its mirrors or `LP-PPA-<name>` for a PPA; an empty
source list means the version came from a local `.deb` or the package lists
are missing, which `package_lists_present` tells apart. apt's lists folder,
and the trusted keys below, are where `apt-config` resolves
`Dir::State::Lists`, `Dir::Etc::TrustedParts` and `Dir::Etc::Trusted` under
`Dir`, so an `APT_CONFIG` file that moves them is followed: on a computer
without lists, an ordinary user can run `apt-get update` with an `APT_CONFIG`
naming writable `Dir::State::Lists` and `Dir::Cache` folders and capture with
the same `APT_CONFIG`. Without `apt-config`, or when it fails, they are
`/var/lib/apt/lists`, `/etc/apt/trusted.gpg.d` and `/etc/apt/trusted.gpg`.

The Debian package is the one `dpkg-query -S` names as the owner of the
desktop entry the capture launched, or else of the executable, since the
entry's package is what installs the application: LibreOffice Writer's entry
belongs to `libreoffice-writer`, while the `/usr/bin/libreoffice` it runs
belongs to `libreoffice-common`, which does not bring Writer with it. When the
two differ, `executable_package` names the executable's package, which the
export installs beside the entry's, since the entry's package need not depend
on it (`vim-common` owns Vim's entry but does not depend on `vim`).
`executable_package_reason` says why the computer could not install it by
name, by the rule for library packages below: neither the Ubuntu 24.04 archive
nor a vendor repository the export declares offers it, or `apt-cache policy`
did not say. When a package owns the entry but none owns its program, such as
a `~/.local/bin/<name>` found first on `PATH`, the entry's package is recorded
without `executable_package`, and `executable_package_reason` says no package
owns the program, so the export refuses rather than install a package that
does not bring it. A program link that dpkg does not own counts as owned when
dpkg owns the file it resolves to, as an alternatives link does. An
`--executable` launch, or an entry no package owns, such as
one in `~/.local/share/applications`, records the executable's package. When
`dpkg-query` does not finish or exits with an error for the executable or the
entry, the package is `unknown` and the limitations say which path, since a
failed lookup is not proof that no package owns it. The sources, vendor
repositories and `--package-file` match below are the recorded package's; the
library walk still reads the executable.

Each source whose origin is not `Ubuntu` is also recorded in
`apt_repositories`. `apt-get indextargets` names the sources file entry apt
read it from and its release, so flat repositories match too, whether their
suite is `./` (Typora's `deb https://downloads.typora.io/linux ./`) or `/`
(pkgs.k8s.io's). The record holds that entry (`sources_file`, `uri`, `suite`,
`components`, none for a flat repository, and `architectures`, the entry's
`arch=` or `Architectures:` restriction, empty when it has none), `release`,
the release's Suite (apt's `a=`) or else its Codename, and the key that signs
it. A user name or password in an entry's URI (`https://user:password@host/…`)
is never recorded: REA removes it from every URI it reads, in the sources file
and in `apt-get indextargets` and `apt-cache policy` output alike, so entries
match whether or not apt prints it, and sets `uri_credentials_removed` on a repository whose URI held
one (a capture written before this was recorded omits the field). The key is
found by verification, not by name: the candidates are the
entry's `signed-by` keyrings, or else every `.gpg` and `.asc` key in apt's trusted
parts folder and its trusted keyring, and each is checked with
`gpgv` against the release's `InRelease` (or `Release` with `Release.gpg`)
beside its index in apt's lists folder. A deb822 entry whose `Signed-By` field
holds the armored key itself, as `add-apt-repository ppa:<owner>/<name>`
writes it on Ubuntu 24.04, has that key as its only candidate, as apt trusts
no other for it: REA reads the field's continuation lines as deb822 writes
them, a `.` line standing for an empty one, from the key block's `BEGIN` line
to its last `END` line, and records the key's path as the entry's sources
file. A key counts when gpgv reports a valid signature by it and no bad,
expired, revoked or unverifiable signature by it, whatever gpgv's exit status:
a release also signed by a key the host lacks makes gpgv fail. Each candidate
is copied, an armored key decoded to a binary keyring, into a private
temporary folder that is removed afterwards; a folder REA cannot remove
fails the capture with the folder as its cleanup resource. The key that
verifies is recorded in `signing_key` with its path,
SHA-256, format (`binary` or `armored`) and primary fingerprint, and its bytes
are retained under `content/`. A key file holding one key is retained as it
is; from one holding several, such as a legacy `/etc/apt/trusted.gpg`, only
the transferable key with the verifying fingerprint is retained, in binary, so
the bundle trusts no other key. When no candidate verifies, `gpgv` is
missing, apt holds no signed release, no sources entry matches, the key the
entry's `Signed-By` holds does not verify the release, or the key is larger
than `--max-file-bytes` or the content budget, `signing_key` is null and
`signing_key_reason` says why. Ubuntu Pro's ESM repositories (origins such as
`UbuntuESMApps`, host `esm.ubuntu.com`) are not checked: apt reaches them only
with the host's Ubuntu Pro credentials, which a computer does not have.

Unless the installed version comes from the Ubuntu 24.04 archive, so for a
vendor repository's package and for a local install that no apt source lists,
`library_packages` lists the packages that own the shared libraries the
executable loads at start; the walk runs beside the repository check, and not
at all for an archive package, whose export does not use it. REA reads
DT_NEEDED from the resolved executable and from each library it finds, and
looks each soname up as ld.so does: in the RPATH of the needing image and of
each image up its chain of loaders to the executable when the needing image
has no RUNPATH, then in its RUNPATH (with `$ORIGIN` expanded and paths
normalized), and then in the `ldconfig -p` cache entries for the executable's
machine. It asks `dpkg-query -S` for each library's package. Libraries in the
executable's own folder belong to the application: they are walked but not
listed, and neither is the application's own package. One batched
`apt-cache policy` then keeps only the packages the Ubuntu 24.04 archive or a
recorded vendor repository with a verified key offers, in any component its
sources entry lists, since the export declares them all; the rest, such as
packages from a PPA or a local `.deb`, are listed in
`uninstallable_library_packages`. The same query checks `executable_package`.
Each recorded repository's `supplies` lists the kept packages, and the
executable's package, that the archive does not offer and its package files
list, so the export can leave out those only a repository it does not declare
supplies, such as one whose key the content budget later dropped. Sonames
found nowhere are listed in
`missing_libraries`, and libraries no package owns in `unpackaged_libraries`.
`library_packages_reason` says why the lists are incomplete: the executable is
not an ELF image (a launcher script, for example), `ldconfig`, `dpkg-query` or
`apt-cache` is missing, `dpkg-query -S` could not tell which package owns a
library (it exits 2 rather than 1, which only says no package owns the paths
it did not name), a library could not be read or names more than 512
libraries, or the walk stopped after 512 libraries. A failed owner query does
not list the libraries it covered in `unpackaged_libraries`, since a lookup
that could not finish is not proof that no package owns them. Completed batches
retain their package and unowned-library facts. Paths containing package-query
pattern characters stay unknown unless another candidate identifies an owner.

A sources file, key or library whose handle REA cannot close fails the capture
with the file as its cleanup resource. When the repository check and the
library walk both fail, the capture reports both failures and every folder or
file either could not release.

An application installed from a `.deb` file you downloaded, such as VariCAD
from varicad.com, has no apt source a computer could install it from. Name
that file with `--package-file` so the export can have the computer download
it instead. REA reads the file's control fields with
`dpkg-deb --field FILE Package Version Architecture Depends Pre-Depends`, and
when its Package, Version and Architecture are the installed package's, it
reads the file once more for its SHA-256 and size and records `package_file`:
the file's `name` without its folder, `sha256`, `size`, `package`, `version`,
`architecture`, and the `depends` and `pre_depends` entries as the file
declares them. Otherwise `package_file_reason` says why, for example that
`dpkg-deb` is not installed, that the file holds another version than the
installed one, or that the file changed between the two reads (its device,
inode, size and times are compared), since its fields and its hash could then
describe different files. The capture never copies the file: it is the vendor's, and only
these facts are kept.

Snaps, flatpaks and
AppImages are recognised from their paths, and flatpaks also from a
`flatpak run` launch, whose application id is the first operand after
flatpak's options and their values. Electron applications are marked by
the fuse sentinel in their binary or a `resources/app.asar` beside it. State
directories are the XDG config, data, state and cache folders and the
dot-folder named after the package, the executable, the desktop entry's full
id and its last part, and the entry's name, with whether each existed at the
start. A folder in those places whose name is one of these in another letter
case joins them, such as GIMP's `~/.config/GIMP` for the `gimp` package; only
the whole name is compared, so `~/.config/GIMPshop` does not. Dotfiles in the
home named after the application (`.<name>rc`, or
`.<name>` followed by `-`, `.` or `_`, for a name of three or more characters)
that exist at the start join them, since an application may only read such a
file during the capture. A `flatpak run` launch is named after its application
id rather than the `flatpak` launcher, and adds `~/.var/app/<id>`.

**Session.** When it started, how long it ran and why it ended; the launched
process's exit status; every process seen in the application's tree; every
client window with its class pair, titles, owner pid and type, marked when it
belongs to the application; when the first application window appeared; the
most common class pair of the application's windows, for matching its window
later; files the application's processes held open under the walked roots; the first
8 KiB of the launched process's stderr; and whether cleanup was verified. Each
process records whether the capture started it: the launched process, a
process carrying the capture's run token, or a descendant of one, even when
its environment cannot be read, as for a zombie or a sandboxed renderer.
Processes are told apart by their start time, so a pid reused by another
process is not counted as the application's.

A window belongs to the application when its owner pid is one of the
application's live processes or its class matches the desktop entry's
`StartupWMClass`, the executable's name, the entry's full id or its last part,
or a flatpak's application id. A flatpak's windows report pids from its
sandbox, so they are matched by class only.
Ownership is checked again at every sample, because a window can appear before
the process that owns it is found. A matching window's pid joins the
application's processes, so a launch handed to a process the capture did not
start, such as a D-Bus activated service, is still followed. That process does
not carry the run token, so the capture never signals it and leaves it
running.

**State.** The walked roots (the home directory plus any content root
outside it), the content roots (state directories, `--state-path` values and
absolute `--argument` values, except `/` or a directory that contains the home
directory, which are named in the limitations instead; a selected path that is
not a directory brings the `-wal` and `-journal` paths beside it, so a database
selected on its own is captured with its logs), the state directories
as walked (their physical spelling, which differs from the inventory's when one
is a symlink), the paths every walk left out (the output folder and
`--exclude` values), and the checkpoints in order: `baseline` before
launch, each requested checkpoint, `stop` or `time-limit`, and `exit` after the
application has gone. Each checkpoint records how many paths its walk saw,
whether it was truncated, how many paths it could not read or directories on
another device it did not enter (`unchecked_paths`), which paths were created, modified, deleted or
changed type since the previous checkpoint, and which files it retained. A
path counts as created or deleted only where the walk listed its nearest
existing directory completely; differences under a directory that could not be
listed, or that a truncated walk did not reach, are counted as unconfirmed
instead. A walk does not enter a directory on another filesystem than its
root, such as an NFS, sshfs or other FUSE mount under the home directory; the
limitations list each such mount point. The
baseline retains every file under the content roots; later checkpoints retain
every changed file. A change records the file's type, size, mode,
modification time and, when known, the SHA-256 of its content before and
after, plus whether it lies in a state directory and whether the application
held it open. A file is retained only if it is still the version the walk
recorded and does not change while it is read. A file larger than the
remaining content budget is not read, unless stored content of the same size
could make it a duplicate. Files that could not be
retained are listed with the reason: too large, over the content budget,
changed since the walk, changed during the read, or unreadable.
Directories the application held files open in, but whose starting content was
not retained, are listed so a second capture can pass them with
`--state-path`.

**Limitations.** What the capture could not establish, such as a truncated
walk or a missing window.

## What the capture does not establish

Changes are found by comparing walks, using each path's size, modification
time, inode and mode, so a change undone between two checkpoints is not seen
and a rewrite that keeps all four is missed. A change is not attributed to the
process that made it: other desktop services write under the home directory
too, such as the dconf database, the window manager's settings and GTK's
recently used list. The markers for state directories and open files are
evidence for attribution, not proof.

Clicks and keystrokes are not recorded. Window titles are sampled every half
second, so short-lived titles can be missed.
