# Applications installed from a downloaded .deb file

## Outcome

A closed-source application the user installed from a `.deb` file they
downloaded, which no apt repository lists, first VariCAD from varicad.com, is
captured with that file's control fields, SHA-256 and size and the packages of
the libraries it loads, and exported as a computer app that downloads exactly
that file from a URL the operator chooses when the bundle is put, installs its
dependencies with apt, installs the file with dpkg, and starts it. Neither the
capture nor the bundle holds the package.

## Requirements

- Capture: `--package-file PATH` names the `.deb` file, made absolute against
  the caller's directory. REA reads its control fields with
  `dpkg-deb --field PATH Package Version Architecture Depends Pre-Depends`,
  through the inventory's query runner and without a shell. When its Package,
  Version and Architecture are the installed package's name (without an
  architecture qualifier), version and architecture as dpkg reports them, REA
  streams the file once through one admitted descriptor, which must hold still
  while it is read, for its SHA-256 and size. The package section then records
  `package_file`: `name` (the file name without its folder), `sha256`, `size`,
  `package`, `version`, `architecture`, and `depends` and `pre_depends`, the
  entries of each relationship field as the file declares them. Otherwise
  `package_file_reason` says why: dpkg reports no installed version of the
  application, the path is not a regular file, `dpkg-deb` is missing or cannot
  read it, it lacks one of the three fields, it holds another package, version
  or architecture, or it could not be read. A descriptor whose close fails
  fails the capture with its owner. The file is never copied into the capture
  folder.
- Library packages are walked as for a vendor repository's package also for a
  local install, a `deb` package whose installed version no apt source lists,
  since a vendor-built binary may load libraries its Depends leaves out. They
  are matched against the origin `apt-cache policy` reports for every package
  file, so a local install's library packages from the Ubuntu archive count as
  installable.
- Export: `--package-url URL` names where the computer downloads the file.
  When the package is a `deb` that neither the Ubuntu 24.04 archive nor a
  declarable vendor repository installs, the capture recorded `package_file`,
  and the URL is given, the class declares:
  - `Download(url=URL, sha256=..., to="vendor/<file name>", arch=...)`, which
    agentenv fetches once when the bundle is put and refuses unless its
    SHA-256 is the captured file's;
  - `Packages(apt=[...])` with the first alternative of each Depends and
    Pre-Depends entry, without its version constraint or architecture
    qualifier, once each, then the capture's library packages, and
    `dconf-cli` when settings are loaded;
  - `RunScript(script="install-package.sh")`, a script the export writes into
    the environment folder: `#!/bin/sh`, `set -eu`, `dpkg -i` of the
    download, then `rm -f` of it, each path shell-quoted. agentenv runs it as
    root with `cd <prefix> && ./install-package.sh` once the apt packages are
    installed and the download is placed, with the network off.

  The bundle supports only the file's architecture: `amd64` or `arm64`, or the
  capture host's for an `all` package. When a recorded vendor repository could
  not be declared, the file is used instead and the repository is left out
  with a limitation.

- Refusals, each naming the input to change and how: a local install exported
  without `--package-url`, which says to capture with `--package-file` and
  export with `--package-url`, or only the latter once the capture recorded the
  file; `--package-url` when the capture recorded no package file, or recorded
  `package_file_reason`, which the refusal repeats; `--package-url` for a
  package the archive or a declared repository installs; a URL that is not
  written as `http://` or `https://`, or that holds a user name or password;
  and a file built for an architecture no computer runs.
- README and limitations: the computer downloads the URL when the bundle is
  put and checks its SHA-256; the bundle does not contain the package; vendor
  sites may refuse automated downloads, so the URL must point at a copy of the
  file the operator may use; the package's licence, such as a trial's terms,
  is the operator's to check; and the computer installs exactly that file's
  version. A dependency entry whose first alternative names no package is
  listed as not installed.

## Non-goals

- Downloading the package from the vendor's site, or keeping it in the
  capture or the bundle.
- Checking that the Ubuntu 24.04 archive offers every dependency, choosing an
  alternative other than the first, or resolving virtual packages.
- Pinning the dependencies' versions.
- Other package formats: RPMs, tarballs and installers.
