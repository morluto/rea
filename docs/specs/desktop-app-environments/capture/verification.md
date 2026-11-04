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
- The new domain, adapter and service tests on Linux: 46 passed, including
  three captures of a fake application with a stub `xprop`: a requested
  checkpoint with the state change and its content, an application that exits
  on its own, and a refusal while the application's window is already open.

## Mousepad end to end

`capture-desktop-application --desktop-entry org.xfce.mousepad` ran as an
ordinary user while `xdotool` typed a line, sent `typed`, saved the file as
`~/Documents/groceries.txt` through the Save As dialog, sent `checkpoint saved`
and then `stop`. The session was recorded with `ffmpeg` (30 seconds).

- Inventory: the entry's `Exec=mousepad %U` became `["mousepad"]`; the
  package is `mousepad` 0.6.1-1build2 from
  `http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages`; no
  Electron markers.
- Session: the first window appeared after 527 ms; the Mousepad window's
  titles went from `Untitled 1 - Mousepad` to `*Untitled 1 - Mousepad` to
  `~/Documents/groceries.txt - Mousepad`; the `Save As` dialog was recorded as a
  dialog of the application; the progress terminal's window was recorded and
  not attributed. The window match is class `Mousepad`, instance `mousepad`.
  The session ended on `stop` after 25.9 s and Mousepad exited with code 0.
- State: checkpoints `baseline`, `typed`, `saved`, `stop` and `exit`. `saved`
  holds `~/Documents/groceries.txt` as created, and its retained content is
  `Groceries: milk, eggs, coffee` with a matching SHA-256. `exit` holds
  `~/.config/Mousepad/accels.scm`, marked as a state directory. The dconf
  database, the window manager's settings and GTK's recently used list also
  changed and are not marked. Nine files (27,256 bytes) were retained and none
  were omitted.

A second run started Mousepad before the capture. The capture refused with
`The application is already open: "Untitled 1 - Mousepad" (pid 35).` and wrote
nothing to the output folder. Before that refusal existed, the same setup
showed Mousepad handing the launch to the running instance, which opened a new
tab in its existing window while the launched process exited at once.

## Limits of this verification

- Only Mousepad was captured end to end, on arm64 in a container. GnuCash,
  Joplin and a full desktop VM are for later steps.
- No real snap, flatpak or AppImage application was captured; those paths are
  covered by parser tests only.
- The time limit and cancellation paths are covered by code review, not by a
  test.
