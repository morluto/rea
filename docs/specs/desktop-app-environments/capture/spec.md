# Capture a Linux desktop application in use

## Outcome

`rea capture-desktop-application` launches an installed Linux desktop
application on the user's X11 display, watches it while a person or a driver
uses it, and writes a capture folder: Evidence in `capture.json` and the bytes
of retained files in `content/<sha256>`. The Evidence says what the
application is and how it was installed, how to launch and recognise it, when
its window appeared, and how files under the home directory changed between
checkpoints, with the content of the files involved. Later steps read this
folder to build the environment; this step builds nothing.

## Requirements

- The baseline records each observed non-file path and its type without
  following symlinks, so a later state reader can distinguish an absent SQLite
  sidecar from an observed non-file.

- The command is CLI only. A capture is a long interactive session whose
  checkpoints come from stdin lines (empty, `checkpoint [name]` or other
  text) and which ends on `stop` or the end of stdin, when the launched
  process has exited and the application's processes and windows are gone,
  or at the time limit. One queued line is handled per sample, and stdin
  reading pauses while 16 wait. A repeated name or one of the capture's own
  names (`baseline`, `stop`, `time-limit`, `exit`) is refused on stderr and
  the session continues. The application has exited only after two
  consecutive samples with the launched process gone, no process carrying the
  run token left, and a window list that was read and holds none of its
  windows; an unreadable list counts as unknown and is named in the
  limitations.
- It runs only on Linux with `DISPLAY` set and `xprop` available (or
  `REA_XPROP_COMMAND`). Before writing or launching anything it refuses other
  hosts, a request naming neither or both of `--desktop-entry` and
  `--executable`, an empty `--state-path`, `--exclude` or `--output` value,
  a program found only through a relative or empty entry of the host's
  `PATH` (lookup follows the launch's search order; an `env` prefix's `PATH`
  travels with the command and may hold such entries),
  an output folder that is not new or empty or is owned by another user, an
  unreadable window list, a window manager that does not publish
  `_NET_CLIENT_LIST` (EWMH), and an application that already has a window
  open. The output folder is made private (0700) and its files are
  created exclusively (0600).
- The inventory resolves a desktop entry id through `$XDG_DATA_HOME` and
  `$XDG_DATA_DIRS`, following an entry installed as a symbolic link, expands
  its `Exec` line with no files and appends `--argument` values, resolves the
  program on `PATH` (the one an `env NAME=value` prefix sets, whose XDG
  folders also name the state directories), and identifies the package:
  snap, flatpak and AppImage from paths (and the AppImage magic, and a
  `flatpak run` launch), otherwise
  the dpkg owner of the launched desktop entry, or else of the executable,
  with its version, architecture, the apt sources listing the
  installed version and the `o=` origin apt reports for each source. The
  entry's package is the one that installs the application: LibreOffice
  Writer's entry belongs to `libreoffice-writer`, while the `libreoffice` it
  runs belongs to `libreoffice-common`, which does not depend on Writer. When
  the two differ, `executable_package` names the executable's, with
  `executable_package_reason` when neither the Ubuntu 24.04 archive nor a
  declared vendor repository offers it or apt could not say; each vendor
  repository records in `supplies` the library packages and executable's
  package only vendor repositories offer that its package files list. When
  a package owns the entry but none owns the program, nor the file it resolves
  to, `executable_package_reason` says so without `executable_package`. A
  `dpkg-query` lookup that does not finish or exits with an error leaves the
  package
  `unknown`, with a limitation naming the path. It marks
  Electron applications by the fuse sentinel or `resources/app.asar`, and
  lists candidate state directories under the XDG folders and dot-folders
  named after the package, executable, desktop entry's full id and last part,
  and name, and every folder present there whose name is one of those in
  another letter case, such as GIMP's `~/.config/GIMP`, and KDE's
  `<name>rc` in the config folder, such as `~/.config/tellicorc`; a `flatpak run`
  launch uses the application id (its first operand
  after options and their values) instead of the launcher's name and adds
  `~/.var/app/<id>`. An `--executable` runs from the caller's
  directory, which also resolves a relative path to it.
- Paths are compared in their physical spelling. The walked roots are the
  home directory and every content root outside it: the state directories,
  `--state-path` values and absolute arguments other than `/` or a directory
  containing the home directory, which the limitations name instead, plus the
  `-wal` and `-journal` paths beside each of those selected paths that is not
  a directory, so a database selected on its own is captured with its logs.
  Each selected path is also recorded as named, beside its physical
  spelling, so a role can follow from the name the caller gave it. The
  baseline walk runs before launch and retains every file under the content
  roots; each later checkpoint reports created, modified, deleted and retyped
  paths against the previous walk and retains every changed file. A creation
  or deletion is reported only where the walk listed the path's nearest
  existing directory completely; the rest are counted as unconfirmed. Walks
  do not follow symbolic links, do not enter a directory on another device
  than their root (the limitations name each such mount point), leave out the
  output folder and `--exclude` paths, which the capture records as
  `excluded`, and stop at `--max-entries`, roots included.
- Retention opens files without following links or blocking, keeps a file
  only if it is still the version the walk recorded and does not change while
  read, respects `--max-file-bytes`, and charges `--max-content-bytes` only
  for content not already stored. A file over the remaining budget is not
  read unless stored content of the same size could make it a duplicate.
  Every omission is recorded with its reason.
- The application is launched through REA's owned process path: its own
  process group and a run token in its environment. Every half second the
  session reads its process tree from procfs, the client list with `xprop`,
  and the files its processes hold open under the walked roots. A window
  belongs to the application by live owner pid or by class (including the
  entry's full id and a flatpak's application id), re-evaluated every sample;
  a flatpak's windows are matched by class only. A matching window's pid is
  followed too. Processes are identified by pid and start time, and each
  records whether the capture started it: the launched process, a run-token
  carrier or a descendant of one.
- When the session ends it records a `stop` or `time-limit` checkpoint if the
  application is still running, sends SIGTERM to the launched process, its
  process group and every process carrying the run token, waits up to five
  seconds, removes every process still carrying the run token, and records an
  `exit` checkpoint. Processes without the token are never signalled outside
  the launch group. Cancellation ends the session without further
  checkpoints, releases the application the same way, and still writes the
  capture with end reason `cancelled`; cancellation before launch writes no
  capture and removes the retained content. Any other failure before `capture.json` is written releases the
  application the same way and removes the retained content; processes or
  files that remain are reported as cleanup facts with the failure.
- The Evidence uses provider `rea-desktop` version 1, operation
  `capture_desktop_application` and predicate type
  `rea.desktop-application-capture`; its parameters carry only counts and the
  launch kind.

## Non-goals

- No state view, format readers, export, tasks or verification; later steps
  own those.
- No click or keystroke recording, no Wayland-native windows, no MCP tool.
- No writer attribution. State-directory and open-file markers are evidence,
  not proof.
- No redaction of the user's files. The capture folder is private data.
