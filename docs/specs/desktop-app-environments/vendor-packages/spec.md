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
  the source as `apt-cache policy` lists it, and the sources file entry
  `apt-get indextargets` names for it (its `Sourcesentry` file and line or
  deb822 stanza; `sources.list`, one-line `*.list` or deb822 `*.sources`) with
  its URI, suite, components and architecture restriction. Flat repositories
  (suite `./` or `/`, no components), `[signed-by=…]` and `Signed-By:` options
  and architecture options are read; a deb822 stanza's URIs and suites are
  kept as lists, never expanded into every pair. `release` is the release's
  Suite (`a=`), or else its Codename, from the same index target. A user name
  or password in a URI, up to the last `@` before its path as apt reads it,
  is removed from every sources entry, from `apt-get indextargets`'
  `Description`, `Repo-URI` and `Base-URI`, and from the sources
  `apt-cache policy` lists, as they are parsed, so no stanza, entry, record,
  reason or limitation holds it and entries match whether or not apt prints
  it; `uri_credentials_removed` records that the entry's URI held one.
  Captures written before `architectures`, `release` and
  `uri_credentials_removed` were recorded omit them, and still open.
- The repository's key is the candidate that verifies the release beside the
  index in apt's lists folder (`InRelease`, or `Release` with `Release.gpg`,
  named from the target's `Base-URI`) with
  `gpgv --status-fd 1 --keyring KEYRING`, where KEYRING is the candidate as a
  binary keyring, run through the inventory's query runner without a shell.
  A VALIDSIG counts whatever gpgv's exit status, unless a BADSIG, EXPSIG,
  EXPKEYSIG, REVKEYSIG or ERRSIG names the same key. Candidates are the
  entry's Signed-By keyrings, or every `.gpg` and `.asc` key in
  `/etc/apt/trusted.gpg.d` and `/etc/apt/trusted.gpg`. Each is written into a
  private temporary folder, an armored key decoded to binary in REA, and the
  folder is removed; a failed removal fails the capture with the folder's
  owner and cleanup facts, as does a sources file, key or library whose
  handle cannot be closed. When the repository check and the library walk
  both fail, the failure keeps both causes and every owner. The verified
  key's path, SHA-256, format and primary fingerprint are recorded and its
  bytes retained in the capture's content store, within `--max-file-bytes`
  and the content budget. A key file holding one key is retained as it is;
  from a file holding several, only the transferable key whose primary
  fingerprint matches is retained, in binary. Without a verified key,
  `signing_key` is null and `signing_key_reason` says why. Ubuntu Pro ESM
  repositories are not checked, with a reason naming the Ubuntu Pro
  credentials a computer lacks.
- Library packages, only when the installed version has apt sources and none
  is the Ubuntu 24.04 archive, walked beside the repository check: from the
  resolved executable, DT_NEEDED is read with REA's ELF readers, at most 512
  distinct needed names per image, recursively. Each soname is resolved as
  ld.so does: the RPATH of the needing image and of each loader up to the
  executable when the needing image has no RUNPATH, then its RUNPATH
  (`$ORIGIN` expanded, paths normalized), then the `ldconfig -p` cache;
  libraries in the executable's own folder are the application's. Resolved
  libraries are mapped to packages with batched `dpkg-query -S`, and a batched
  `apt-cache policy` keeps those the Ubuntu 24.04 archive offers, or any
  component of a vendor repository's entry with a verified key, since the
  export declares every component. The capture records
  `library_packages` (sorted, without architecture qualifiers or the
  application's own package), `uninstallable_library_packages`,
  `missing_libraries`, `unpackaged_libraries`, and `library_packages_reason`
  when the walk was skipped (not an ELF image), stopped at 512 libraries, or
  could not read a library.
- Export: a package from the Ubuntu 24.04 archive installs by name as before,
  for amd64 and arm64. Otherwise each usable vendor repository is declared as
  `AptSource(apt, suite, components, key="apt-keys/<name>.gpg|.asc")` with the
  retained key copied into the environment folder, one source per URI and
  suite; the package is named `<package>/<release>` from the first declared
  repository, so its release wins over the archive, and the bundle supports
  only the capture host's architecture. A repository is usable when its key
  was verified, its sources entry's URI held no user name or password
  (`uri_credentials_removed`, or one still in `uri` in a capture written
  before that field), it is reached over http or https, and its architecture
  restriction includes the host's. With none usable, the export is refused
  naming each repository, by its URI without credentials, and its reason; the
  credentials reason names no URI. A capture written before
  restrictions and releases were recorded counts its repositories as
  unrestricted and names the package alone. For a vendor package, library
  packages follow the application's package in `Packages(apt=[…])`, and
  uninstallable ones are reported as a limitation; an archive package's
  declared dependencies are trusted as they are.
- Electron: when the capture marked the application as Electron and its
  command lacks `--no-sandbox`, the launch adds it right after the program,
  after any `env` assignments; the README and the export's limitations say
  Chromium's sandbox is off and why.
- `data/get` waits a quarter of a second for a write lock on an SQLite file.

## Non-goals

- Keys held inline in a deb822 `Signed-By` field, Signed-By fingerprints
  matched against the signing key, and repositories reached over anything but
  http or https.
- Pinning the captured version, carrying the host's apt pinning over, or
  checking that the capture host's suite suits Ubuntu 24.04.
- Ubuntu Pro repositories, which need the host's credentials, and other
  repositories that need a user name or password: one held in an entry's URI
  is refused, and apt's `auth.conf` is not read.
- Libraries an application opens with `dlopen` rather than DT_NEEDED.
