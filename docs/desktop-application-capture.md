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
Applications that run under XWayland are visible; native Wayland windows are
not. Other hosts are refused before anything is launched.

## Capture an application

Name the application by its desktop entry id, the entry's absolute path, or an
executable:

```sh
rea capture-desktop-application --desktop-entry org.xfce.mousepad --output ./mousepad-capture
rea capture-desktop-application --executable gnucash --argument /home/ada/books.gnucash --output ./gnucash-capture
```

Desktop entries are looked up in `$XDG_DATA_HOME/applications` and then each
`$XDG_DATA_DIRS` directory. The entry's `Exec` line is expanded with no files;
`--argument` values are appended in its place, and the application runs in the
entry's `Path` or the home directory. An `--executable` runs from the current
directory, as it would from a shell, and a relative path to it is resolved
there.

Before writing anything the command refuses to start if a window of the
application is already open, or if the window list cannot be read. A launch
beside a running instance can hand off to it, and that instance's unsaved
state would be missing from the baseline. It then records the starting state,
launches the application in its own process group with a run token in its
environment, and reads commands from stdin, one per line:

| Line                                        | Effect                                                      |
| ------------------------------------------- | ----------------------------------------------------------- |
| empty, `checkpoint`, or `checkpoint <name>` | Record the current state as a checkpoint                    |
| any other text except `stop`                | Record a checkpoint named by that text                      |
| `stop`                                      | Record a final checkpoint, close the application and finish |

The session also finishes when the launched process has exited and the
application's processes and windows are all gone, or when
`--max-duration-seconds` passes. One queued line is handled between samples,
and reading stdin pauses while 16 lines wait. Progress lines on stderr say when
the window has opened and when each checkpoint is taken.

When the session ends the capture sends SIGTERM to the launched process, waits
up to five seconds, and then removes every process that still carries the run
token, whether or not it stayed in the process group. Interrupting the command
(Ctrl-C) ends the session the same way without a further checkpoint; the
capture is still written with end reason `cancelled`, and the command exits
with status 130.

A person types these lines in the terminal. An agent can drive the
application with a tool such as `xdotool` and write the lines to a FIFO that
it passes as stdin.

| Option                   | Default | Meaning                                                                                   |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| `--state-path`           | none    | File or directory whose starting content is retained too (repeatable)                     |
| `--exclude`              | none    | Path left out of every checkpoint walk (repeatable); the output folder is always left out |
| `--max-duration-seconds` | 3600    | Stop the session after this long                                                          |
| `--max-entries`          | 250,000 | Paths recorded per checkpoint walk                                                        |
| `--max-file-bytes`       | 64 MiB  | Largest file whose content is retained                                                    |
| `--max-content-bytes`    | 1 GiB   | Total retained content                                                                    |

## The capture folder

The output folder must be new, or empty and owned by the current user; the
command makes it private (mode 0700). It holds:

- `capture.json`: the Evidence record, also printed on stdout.
- `content/<sha256>`: the bytes of each retained file, stored once per
  distinct content.

The Evidence operation is `capture_desktop_application` and its predicate type
is `rea.desktop-application-capture`. Its result has four parts.

**Application.** The desktop entry (id, path, name, `Exec`, icon,
`StartupWMClass`, categories, MIME types), the launch command and working
directory, the executable as found on `PATH` and after resolving links, and the
package that installed it. A Debian package records its name, version,
architecture and the apt sources that list the installed version; an empty
source list means the version came from a local `.deb` or the package lists
are missing, which `package_lists_present` tells apart. Snaps, flatpaks and
AppImages are recognised from their paths. Electron applications are marked by
the fuse sentinel in their binary or a `resources/app.asar` beside it. State
directories are the XDG config, data, state and cache folders and the
dot-folder named after the package, the executable, the desktop entry id and
name, with whether each existed at the start.

**Session.** When it started, how long it ran and why it ended; the launched
process's exit status; every process seen in the application's tree; every
client window with its class pair, titles, owner pid and type, marked when it
belongs to the application; when the first application window appeared; the
most common class pair of the application's windows, for matching its window
later; files the application's processes held open under the walked roots; the first
8 KiB of the launched process's stderr; and whether cleanup was verified. Each
process records whether it carries the capture's run token.

A window belongs to the application when its owner pid is one of the
application's processes or its class matches the desktop entry's
`StartupWMClass`, the executable's name or the last part of the entry id.
Ownership is checked again at every sample, because a window can appear before
the process that owns it is found. A matching window's pid joins the
application's processes, so a launch handed to a process the capture did not
start, such as a D-Bus activated service, is still followed. That process does
not carry the run token, so the capture never signals it and leaves it
running.

**State.** The walked roots (the home directory plus any content root
outside it), the content roots (state directories, `--state-path` values and
absolute `--argument` values), and the checkpoints in order: `baseline` before
launch, each requested checkpoint, `stop` or `time-limit`, and `exit` after the
application has gone. Each checkpoint records how many paths its walk saw,
whether it was truncated, which paths were created, modified, deleted or
changed type since the previous checkpoint, and which files it retained. A
path counts as created or deleted only where the walk listed its nearest
existing directory completely; differences under a directory that could not be
listed, or that a truncated walk did not reach, are counted as unconfirmed
instead. The
baseline retains every file under the content roots; later checkpoints retain
every changed file. A change records the file's type, size, mode,
modification time and, when known, the SHA-256 of its content before and
after, plus whether it lies in a state directory and whether the application
held it open. A file is retained only if it is still the version the walk
recorded and does not change while it is read. Files that could not be
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
