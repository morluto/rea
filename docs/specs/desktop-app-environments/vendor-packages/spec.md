# Applications from a vendor apt repository

## Outcome

A closed-source application installed from its vendor's apt repository, first
Typora from `https://downloads.typora.io/linux`, is captured with the
repository, the key that signs it and the packages of the libraries it loads,
and exported as a computer app that installs it from that repository, trusting
that key, with those libraries, and starts it.

## Requirements

- Capture: for each apt source of the installed version whose origin is not
  `Ubuntu`, the package section records a repository in `apt_repositories`:
  the source as `apt-cache policy` lists it, and the sources file entry it
  comes from (`sources.list`, one-line `*.list` or deb822 `*.sources`) with its
  URI, suite and components. Flat repositories (suite `./`, no components),
  `[signed-by=…]` and `Signed-By:` options and architecture options are read.
  Captures written before the field existed still parse.
- The repository's key is the candidate that verifies the repository's signed
  release in apt's lists directory (`InRelease`, or `Release` with
  `Release.gpg`) with `gpgv --status-fd 1 --keyring <binary keyring>`, run
  through the inventory's query runner without a shell. Candidates are the
  entry's Signed-By keyrings, or every `.gpg` and `.asc` key in
  `/etc/apt/trusted.gpg.d` and `/etc/apt/trusted.gpg`. Each is written into a
  private temporary folder, an armored key decoded to binary in REA, and the
  folder is removed. The verified key's path, SHA-256, format and fingerprint
  are recorded and its bytes retained in the capture's content store. Without
  a verified key, `signing_key` is null and `signing_key_reason` says why.
- Library packages: from the resolved executable, DT_NEEDED is read with REA's
  ELF readers, recursively, each soname resolved through the needing image's
  RUNPATH or RPATH (`$ORIGIN` expanded) and the `ldconfig -p` cache; libraries
  in the executable's own folder are the application's. Resolved libraries are
  mapped to packages with batched `dpkg-query -S`. The capture records
  `library_packages` (sorted, without architecture qualifiers or the
  application's own package), `missing_libraries`, `unpackaged_libraries`, and
  `library_packages_reason` when the walk was skipped (not an ELF image),
  stopped at 512 libraries, or could not read a library.
- Export: a package from the Ubuntu 24.04 archive installs by name as before.
  Otherwise each vendor repository with a verified key is declared as
  `AptSource(apt, suite, components, key="apt-keys/<name>.gpg|.asc")` with the
  retained key copied into the environment folder; with none, the export is
  refused naming each repository and its reason. For a vendor package, library
  packages follow the application's package in `Packages(apt=[…])`; an archive
  package's declared dependencies are trusted as they are.
- Electron: when the capture marked the application as Electron and its
  command lacks `--no-sandbox`, the launch adds it right after the program;
  the README and the export's limitations say Chromium's sandbox is off and
  why.

## Non-goals

- Keys held inline in a deb822 `Signed-By` field, Signed-By fingerprints
  matched against the signing key, and repositories reached over anything but
  http or https.
- Pinning the captured version, or checking that the capture host's suite
  suits Ubuntu 24.04.
- Libraries an application opens with `dlopen` rather than DT_NEEDED.
