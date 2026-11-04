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

- The command is CLI only. A capture is a long interactive session whose
  checkpoints come from stdin lines (empty, `checkpoint [name]` or other
  text) and which ends on `stop`, when the application's processes and
  windows are gone, or at the time limit.
- It runs only on Linux with `DISPLAY` set and `xprop` available (or
  `REA_XPROP_COMMAND`), and refuses other hosts before launching anything.
  Exactly one of `--desktop-entry` and `--executable` names the application.
  The output folder must be new or empty.
- The inventory resolves a desktop entry id through `$XDG_DATA_HOME` and
  `$XDG_DATA_DIRS`, expands its `Exec` line with no files and appends
  `--argument` values, resolves the program on `PATH`, and identifies the
  package: snap, flatpak and AppImage from paths (and the AppImage magic),
  otherwise the dpkg owner with its version, architecture and the apt sources
  listing the installed version. It marks Electron applications by the fuse
  sentinel or `resources/app.asar`, and lists candidate state directories
  under the XDG folders and dot-folders named after the package, executable,
  desktop entry id and name.
- The baseline walk runs before launch and retains every file under the
  content roots: the state directories, `--state-path` values and absolute
  arguments. Each later checkpoint walks the same roots, reports created,
  modified, deleted and retyped paths against the previous walk, and retains
  every changed file. Walks do not follow symbolic links, leave out the
  output folder and `--exclude` paths, and stop at `--max-entries`.
  Retention respects `--max-file-bytes` and `--max-content-bytes` and leaves
  out files that change while read, recording why.
- The application starts in its own process group. Every half second the
  session reads the application's process tree from procfs, the window
  manager's client list with `xprop`, and the files its processes hold open
  under the walked roots. A window belongs to the application by owner pid or
  by class; a matching window's pid is followed too. A capture refuses to
  start, before writing anything, while a matching window is already open.
- On `stop` or the time limit the session records a checkpoint, sends SIGTERM
  to the process group and every process in the launched tree, and SIGKILL
  after five seconds. A process found only as the owner of a matching window
  is never signalled and does not keep the session open. Every session ends with an `exit` checkpoint. Cancellation also
  terminates the application.
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
