# Verification

Run on 2026-11-04 on top of the desktop tasks branch: gates and source tests on
macOS with Node v22.23.1; Linux runs in the `rea-desktop-e2e` Ubuntu 24.04
arm64 container with Node v24.22.1 and dpkg 1.22.6. The real VariCAD run was on
an x86_64 Ubuntu 24.04 EC2 host, VariCAD being amd64 only; see
[VariCAD](#varicad).

## Gates

- `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `knip` (after
  `build:cached`), `jscpd`, `docs:check`, `docs:build`,
  `verify:test-discovery` and `verify:architecture-guards`: passed, with no
  lint or typed-lint diagnostics in the touched files. jscpd reports no clone
  in the new code; the one clone it lists in a touched file,
  `DesktopApplicationCapture.test.ts` against itself, was there before.
- `npx vitest run src/domain/desktop src/application/desktop src/desktop` with
  `tests/boundary/providers/desktopInstallScript.test.ts`,
  `desktopExportPython.test.ts` and `desktopTaskPython.test.ts`, with the CLI
  boundary tests below: on macOS 325 passed and 15 skipped (Linux-only cases,
  the real `dpkg-deb` one among them). Without the CLI tests, in the container
  on the x86_64 host, 309 passed and 1 skipped (a checkpoint recorder case
  skipped there before this change).
- The CLI boundary tests `cliInputSchemaRequired`, `cliToolCoverage` and
  `cliStartupImports`: 30 passed.

## Tests

- The `dpkg-deb --field` reader on dpkg 1.22.6's output for a package whose
  Depends has alternatives, version constraints and a `:any` qualifier, with
  Pre-Depends; a field the file lacks, a folded field, and output without
  Package, Version or Architecture. `dpkg-deb` itself prints a relationship
  field on one line, also for a hand-built archive whose control file folds
  it.
- The match against the installed version, an architecture-qualified dpkg
  name included, and its reason when the version, architecture or name
  differs; the dependency names (first alternative, no version or qualifier,
  once each) and entries that name no package.
- The package file adapter with a fake query runner: the facts and the exact
  `dpkg-deb` arguments; another version; `dpkg-deb` missing or exiting 2; an
  application dpkg did not install (no `dpkg-deb` call); a directory. On Linux,
  a package built with `dpkg-deb --build` read by the real `dpkg-deb`.
- The inventory: a local install, which no apt source lists, walks its
  libraries and matches them to the archive by origin, and records its package
  file through `inspectLinuxApplication`.
- The capture schema: an inventory without the new fields, with
  `package_file` and with `package_file_reason` parses; a file name that is a
  path, `..` or empty does not.
- The install decision: a local-deb capture with a URL (the download, its
  path and architecture, the apt packages, the library packages); an `all`
  package on the capture host's architecture; a recorded vendor repository
  that cannot be declared, left out in favour of the file; each refusal (no
  URL with and without a recorded file, a URL without a recorded file and
  with `package_file_reason`, a URL for an archive or a declared repository
  package, `ftp://`, `HTTPS://`, a bare host and path, a URL with a password,
  which the refusal does not repeat, and an `i386` file); the limitations.
- The renderers: the `@linux(...)` declaration, the import, the run script and
  its quoting, and the README. The export service: a local-deb capture with a
  URL writes `install-package.sh` and no `vendor/` folder, and declares the
  download; without a URL it refuses with the `package_url` field and writes
  nothing.
- The run script, run as agentenv runs it (`cd <prefix> && ./install-package.sh`)
  with a stub `dpkg`, on a download named `vendor/vari'cad $HOME *.deb`:
  `dpkg -i` receives that one path and the file is removed; when `dpkg` fails
  the script fails and the file stays.

## Checks beyond the tests

- A sample class for VariCAD's file (Depends `libc6 (>= 2.34)`,
  `libgl1 | libgl1-mesa-glx`, `libstdc++6:any (>= 12)`, `libx11-6`; library
  packages `libglu1-mesa`, `libxt6t64`) renders:

  ```python
  @computer_app(supports=[{"os": {"type": "linux", "display": ["x11"]}, "arch": ["amd64"]}])
  @linux(
      packages=Packages(apt=["libc6", "libgl1", "libstdc++6", "libx11-6", "libglu1-mesa", "libxt6t64"]),
      downloads=[Download(url="https://mirror.example.com/varicad/varicad2026-en_2.03_amd64.deb", sha256="5f5f…5f", to="vendor/varicad2026-en_2.03_amd64.deb", arch="amd64")],
      run=[RunScript(script="install-package.sh")],
      launch=Launch(at="boot", command=["varicad"], window={"class": "Varicad"}, ready=Ready(window=True)),
      paths=PATHS,
      skill="SKILL.md",
  )
  ```

  `python -m agentenv_protocol.computer._declare` from agentenv-framework
  0.9.1431 exited 0 and declared that download (`arch` `amd64`), the run
  script with scope `system`, and the packages.

- `rea export-desktop-application` on a hand-written local-deb capture with
  `--package-url` wrote `envs/varicad/install-package.sh` and listed the
  download, SHA-256 and licence limitations; `agent-env run <bundle> --dry-run`
  with 0.9.1431 exited 0. Without `--package-url` the export failed with
  `invalid_request` on path `package_url` and wrote no bundle.
- In the container, as root: a `rea-sample` package built from `/usr/bin/true`
  and installed with `dpkg -i` was inventoried with `packageFile` naming its
  file. The inventory recorded `package_file` (its SHA-256, size, and
  `libc6 (>= 2.34)`, `libgl1 | libgl1-mesa-glx`), walked the local install's
  libraries to `library_packages: ["libc6"]` once apt's lists were present,
  explained a rebuilt `1.0-2` file as holding another version than the
  installed `1.0-1`, and a text file as one `dpkg-deb` could not read.
- In a container with `--network none`, as root, the exported script
  installed `vendor/rea sample_1.0-1.deb` from `/opt/app`, which dpkg then
  reported as `install ok installed`, and removed it.

## VariCAD

VariCAD 2026.2.05 (`varicad_2026.2.05_amd64.deb`, 153,794,020 bytes, SHA-256
`1d73f297…6e72`), downloaded from varicad.com in a browser and installed with
`apt-get install ./varicad_2026.2.05_amd64.deb` in the `rea-desktop-e2e` image,
built natively on the x86_64 host. `apt-cache policy` listed only
`/var/lib/dpkg/status` for it: a local install.

VariCAD runs only after logging in to a VariCAD account, which starts its
30-day trial. Before the capture, as prior use, VariCAD was run once: its
first-run dialogs, the login, the trial and its licence, then DXF output set to
AutoCAD R12 in the save dialog's settings. VariCAD's default, DXF 2004, writes
about 20,700 lines, past the 5,000 the text view keeps, so the circles would
fall outside it.

- **Capture.** `capture-desktop-application --desktop-entry varicad
  --argument /home/ada/Documents/plate.dxf --package-file
  /home/ada/Downloads/varicad_2026.2.05_amd64.deb` while four mounting holes were
  added to the LibreCAD plate and it was saved over `Documents/plate.dxf` as DXF.
  The package section recorded `package_file` (`varicad` 2026.2.05 amd64, the
  file's SHA-256 and 35 Depends entries), no apt sources, 79 library packages
  and nothing missing, unpackaged or uninstallable. The account's name and
  password appear nowhere in the capture.
- **First run in the computer.** The first export left out
  `~/.varicad-cfg.ini` and `~/.varicad-work.ini`, which VariCAD writes on its
  first run and only reads afterwards. In the computer it showed its first-run
  dialogs again, and its splash screen, a window of class `varicad` kept above
  the others, counted as the app being ready. The capture now treats dotfiles
  named after the application as state roots. `~/.varicad-work.ini` is UTF-16
  and names `/home/ada/.varicad`, so seeding now respells UTF-16 text with a
  byte-order mark. Readiness now also waits for a window of the class that the
  taskbar lists.
- **Export.** `export-desktop-application ... --task task.json --package-url
  http://127.0.0.1:8765/varicad_2026.2.05_amd64.deb`, a copy served on the
  host's loopback interface, since varicad.com refuses automated downloads. The
  owned paths were `.varicad`, `.varicad-cfg.ini`, `.varicad-work.ini` and
  `Documents`. The task `add-holes` checks `CIRCLE` lines equal 9 and failed on
  the seed (`nine-circles`).
- **Computer.** `agent-env run <bundle> --task seed-probe --keep --no-emulate`
  with agentenv-framework 0.9.1431 on local Docker: the build fetched the file
  from the URL and checked its SHA-256, installed the apt packages, and ran
  `install-package.sh`'s `dpkg -i`. The image passed agentenv's probe. VariCAD
  booted logged in, on its trial reminder, with the plate open, its path
  respelled to `/home/user/Documents/plate.dxf`. The exported verifier scored 0
  on the seed (5 `CIRCLE` lines).
- **The edit in the computer.** Driven through `computer_click`, `computer_key`
  and `computer_type` only: Continue, OK, `ccr` four times in the command line
  with radius 5, then Control+S, the DXF type and the overwrite. The verifier
  then passed (9 lines), and after `data/reset` it failed again (5 lines).
- Only one computer ran VariCAD at a time, as its licence requires.

## Limits of this verification

- The package file was downloaded from a loopback copy, not from the vendor,
  whose site refuses automated clients.
- No agent was run on the VariCAD task, so it has no solve rate.
- The dependencies' first alternatives were not checked against the Ubuntu
  24.04 archive; one the archive lacks fails the build.
- Library packages of a local install were mapped on Ubuntu 24.04 arm64 only.
