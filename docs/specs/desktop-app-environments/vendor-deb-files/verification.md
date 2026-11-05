# Verification

Run on 2026-11-04 on top of the desktop tasks branch: gates and source tests on
macOS with Node v22.23.1; Linux runs in the `rea-desktop-e2e` Ubuntu 24.04
arm64 container with Node v24.22.1 and dpkg 1.22.6. No real VariCAD capture or
export has run yet; see [VariCAD](#varicad).

## Gates

- `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `knip` (after
  `build:cached`), `jscpd`, `docs:check`, `docs:build`,
  `verify:test-discovery` and `verify:architecture-guards`: passed, with no
  lint or typed-lint diagnostics in the touched files. jscpd reports no clone
  in the new code; the one clone it lists in a touched file,
  `DesktopApplicationCapture.test.ts` against itself, was there before.
- `npx vitest run src/domain/desktop src/application/desktop src/desktop` with
  `tests/boundary/providers/desktopInstallScript.test.ts`,
  `desktopExportPython.test.ts` and `desktopTaskPython.test.ts`: on macOS 292
  passed and 15 skipped (Linux-only cases, the real `dpkg-deb` one among
  them); in the container 306 passed and 1 skipped (a checkpoint recorder case
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

> **To be filled in by the real run.** Record the VariCAD version and file
> name, the capture command with `--package-file` and what the package section
> recorded (`package_file`, `library_packages` and anything uninstallable or
> missing), the export command with `--package-url` and the URL's kind (for
> example a private mirror), the rendered `@linux(...)` and limitations, the
> `agent-env run` build (the download fetched and its SHA-256 checked, the
> apt packages, `install-package.sh`'s `dpkg -i`), whether the app reached
> ready on its window, and `data/get` and `data/reset` on its files.

## Limits of this verification

- No agentenv build has downloaded and installed a package file: the
  declaration, the dry run and the run script were checked separately.
- The dependencies' first alternatives were not checked against the Ubuntu
  24.04 archive; one the archive lacks fails the build.
- Library packages of a local install were mapped on Ubuntu 24.04 arm64 only.
