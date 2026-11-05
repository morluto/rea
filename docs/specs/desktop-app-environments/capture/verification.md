# Verification

Run on 2026-11-03 against main `d7df9df33`: gates and source tests on macOS 26.5
with Node v22.23.1; Linux tests and the end-to-end captures in an Ubuntu 24.04.5
arm64 container with Node v24.22.1, Xvfb, xfwm4 and Mousepad 0.6.1-1build2.

## Gates

- `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `knip`,
  `knip:production`, `jscpd`, `docs:check`, `mcp-catalog:check`,
  `verify:test-discovery`, `verify:architecture-guards` and `scan:todos`:
  passed. Lint and typed lint report no diagnostics in the new files.
- `npx vitest run --project domain --project services --project adapters` on
  macOS: 21,581 passed, 29 skipped, 5 failed. The same 5 fail on main in the
  same environment (two zstd cases, Inspector target authorization
  cancellation, and two `setupEnvironment` cases).
- `npx vitest run --project cli-boundary` on macOS: 1,499 passed, 5 skipped, 39
  failed. 38 of them fail on main in the same environment (client profiles,
  setup, doctor and version reports). The 39th, `closedStdout`, passed three
  runs out of three when rerun alone.
- The new domain, adapter and service tests on Linux: 51 passed, including
  five captures of a fake application with a stub `xprop`: a requested
  checkpoint with the state change and its content, an application that exits
  on its own, a refusal while the application's window is already open, a
  refusal when the window list cannot be read, and a cancellation after a
  checkpoint that still writes the capture and verifies cleanup.

## Mousepad end to end

`capture-desktop-application --desktop-entry org.xfce.mousepad` ran as an
ordinary user while `xdotool` typed a line, sent `typed`, saved the file as
`~/Documents/groceries.txt` through the Save As dialog, sent `checkpoint saved`
and then `stop`. The session was recorded with `ffmpeg` (30 seconds).

- Inventory: the entry's `Exec=mousepad %U` became `["mousepad"]`; the
  package is `mousepad` 0.6.1-1build2 from
  `http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages`; no
  Electron markers.
- Session: the first window appeared after about 530 ms; the Mousepad window's
  titles went from `Untitled 1 - Mousepad` to `*Untitled 1 - Mousepad` to
  `~/Documents/groceries.txt - Mousepad`; the `Save As` dialog was recorded as a
  dialog of the application; the progress terminal's window was recorded and
  not attributed. The window match is class `Mousepad`, instance `mousepad`.
  The session ended on `stop` after 25.9 s and Mousepad exited with code 0.
- Cleanup: verified; the only process recorded was `mousepad`, carrying the
  run token.
- State: checkpoints `baseline`, `typed`, `saved`, `stop` and `exit`, none
  with unconfirmed changes. `saved` holds `~/Documents/groceries.txt` as
  created, and its retained content is `Groceries: milk, eggs, coffee` with a
  matching SHA-256. `exit` holds `~/.config/Mousepad/accels.scm`, marked as a
  state directory. The dconf database, the window manager's settings and GTK's
  recently used list also changed and are not marked. Nine files were retained
  and none were omitted.

A second run started Mousepad before the capture. The capture refused with
`The application is already open: "Untitled 1 - Mousepad" (pid 35).` and wrote
nothing to the output folder. Before that refusal existed, the same setup
showed Mousepad handing the launch to the running instance, which opened a new
tab in its existing window while the launched process exited at once.

## Fixes after the five-application test

Run on 2026-11-05 on macOS 26.5 with Node v22.23.1. A test that captured and
exported five applications found two inventory gaps:

- LibreOffice Writer, captured with `--desktop-entry libreoffice-writer`,
  recorded `libreoffice-common`, the owner of the `/usr/bin/libreoffice` its
  entry runs, which does not depend on Writer. The exported computer installed
  only that package and failed its readiness check with
  `no window with class 'libreoffice-writer'`. The package is now the entry's
  owner, with the executable's in `executable_package`. Adapter tests on a
  fake dpkg host whose entry and program have different owners cover an entry
  launch, an `--executable` launch, an entry no package owns and a
  `--package-file` matched against the entry's package.
- GIMP 2.10 keeps its profile in `~/.config/GIMP/2.10`, which no candidate
  name (`gimp`) matched, so it was neither seeded nor reset. A folder in the
  XDG folders or the home whose name is one of the candidate names in another
  letter case is now a state directory, and the state view counts a path in a
  folder beside a state directory that differs from it only in case as in it.
  An adapter test with GIMP's layout and a domain test cover both, and leave
  out `GIMPshop`, `MyGIMP` and a nested `Other/GIMP`.

Review of those fixes found three more gaps, each now covered by a test that
failed on the first fix:

- The entry's package need not depend on the program's (`vim-common` owns
  Vim's entry, `vim` its program), so the export now installs
  `executable_package` by name beside the app's package, for archive, vendor
  repository and package-file installs alike. The capture checks it by the
  library packages' rule and records `executable_package_reason` when neither
  the archive nor a declared repository offers it, or apt could not say; the
  export then refuses. Adapter, domain and export service tests cover the
  record, the three install paths, the refusal and the rendered
  `Packages(apt=[...])`.
- A profile folder created during the capture in another letter case than its
  candidate was application state but owned as the folder of its first file
  (`.config/GIMP/2.10`), so later files elsewhere in it escaped `data/get` and
  `data/reset`. Owned paths now use the same match as roles and own
  `.config/GIMP` in the files' spelling; a domain test and an export service
  test of a created profile cover it.
- A `dpkg-query -S` that timed out or exited with an error counted as "no
  owner", so a failed entry lookup quietly recorded the program's package. It
  now leaves the package `unknown` with a limitation naming the path, for the
  entry and the executable, after a timeout or an exit status of 2.

A later review found that both the program's package and library packages
were approved at capture against every repository with a verified key, while
the content budget can then drop a repository's key and the export leaves that
repository out. Repositories now record what they `supply`, and the export
leaves out library packages, and refuses a program's package, that only
repositories it leaves out supply. A capture adapter test, two export domain
tests and a key-retention service test that drops one of two keys under the
per-file limit cover it.

Each new test failed on the code before its fix, run in a copy of that commit
with only the new tests added. `npm run typecheck`, `lint`, `lint:typed`
(no diagnostics in the touched files), `format:check`, `build:cached`,
`knip`, `jscpd`, `docs:check`, `docs:build`, `verify:test-discovery` and
`verify:architecture-guards` passed, and
`npx vitest run src/domain/desktop src/application/desktop src/desktop tests/boundary/cli/cliStartupImports.test.ts`
ran 347 passed and 18 skipped. Neither application was captured again.

## Limits of this verification

- Only Mousepad was captured end to end, on arm64 in a container. GnuCash,
  Joplin and a full desktop VM are for later steps.
- No real snap, flatpak or AppImage application was captured; those paths are
  covered by parser tests only.
- The time limit is covered by code review, not by a test. Cancellation is
  covered by a Linux test with a fake application, not by Ctrl-C on Mousepad.
