# Applications from an AppImage or tarball

## Outcome

A build computer installs an application that no package offers from its
project's AppImage or tarball, first FreeCAD 1.1.4's AppImage, pinned by URL
and SHA-256, and the exported bundle installs the same file the same way,
with neither the build nor the bundle holding the application.

## Requirements

- Request: `install` takes `{"kind": "appimage", "url", "sha256",
  "architecture", "extra_packages"}` and `{"kind": "tarball", "url",
  "sha256", "architecture", "program", "name", "extra_packages"}`. The URL is
  `http://` or `https://` in lowercase without a user name or password, the
  SHA-256 is lowercase hex, the architecture is `amd64` or `arm64`, and a
  tarball's `program` is a path inside the archive whose segments start with
  neither a dot nor a slash. `name`, optional, is one line of at most 128
  characters. The request's `desktop_entry` names the entry: an AppImage's
  own, or the one REA writes for a tarball.
- Install: agentenv downloads the file when the bundle is put, refusing other
  bytes, to `vendor/app.AppImage` or `vendor/app.tar`; the bundle supports
  only its architecture. A root run script, `install-download.sh`, unpacks it
  with the network off under `/opt/rea-apps/<desktop_entry>`, removes the
  download and makes the folder readable to the session user.
  - An AppImage is extracted with its own `--appimage-extract`. Its top-level
    `<desktop_entry>.desktop` is installed under
    `/usr/local/share/applications` with each `Exec` program replaced by the
    extracted `AppRun`, after any `env` prefix and its assignments, and
    `TryExec` removed, with its `Icon`'s SVG or PNG; an
    image without that entry fails the build, naming the entries it has.
  - A tarball is read with Python's `tarfile` and its `data` filter, since the
    computer has no `xz` program. The filter refuses links that point outside
    the folder, absolute ones included, and special files, failing the build. Its program must be an executable file; the
    entry REA writes into the environment folder, `applications/<desktop
    entry>.desktop`, runs it with `%F`, named by `name` or the entry's last
    part, and the script installs it.
- Build computer: the script runs after REA's own layer and before the
  Electron rewrite, which edits the entry the script installed.
- Export: the build computer passes the request's download to the export in
  a file, `--download-install`, which the CLI also takes. The export renders
  the same files from it: `downloads=[Download(...)]`,
  `run=[RunScript(script="install-download.sh")]`, a tarball's entry, and no
  apt package for the application, beside the extra packages and dconf.
- Refusals (`download_install`, each with its remediation): a file that is
  not JSON or names no AppImage or tarball install; a capture that launched
  another desktop entry; a captured program outside the download's folder;
  a capture host of another architecture. `--package-url` beside it is
  refused (`package_url`).
- README and limitations: the computer downloads the URL when the bundle is
  put and checks its SHA-256; the bundle does not contain the application;
  the URL must keep serving those bytes; the licence is the operator's.

## Non-goals

- Flatpak: bubblewrap needs user namespaces that the computer's container
  (Docker's default seccomp and AppArmor) and an Ubuntu 24.04 host
  (`kernel.apparmor_restrict_unprivileged_userns=1`) refuse, and neither is
  REA's to change.
- Snaps, zstd tarballs, AppImages without `--appimage-extract`, and
  installers.
- One request for both architectures.
- Reclaiming the downloaded file's space in the image: agentenv copies it
  into the app's layer before the script runs.
