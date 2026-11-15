# Inspect a Debian .deb package

This specification records an implementation increment and its original problem
statement. For current behavior and limitations, see the
[current guide](../../../deb-package.md).

## Outcome

A local `.deb` is an ar archive of `debian-binary`, `control.tar*`, and
`data.tar*`. Without a dedicated reader, an analyst installs the package with
`dpkg`, which runs its maintainer scripts and changes the host, or shells out to
`dpkg-deb`, which reads the archive but needs Debian tooling on the host.
`rea inspect-deb-package <path>` reads one explicitly selected archive as
static bytes and reports identity, relationships, script presence, and a
bounded file inventory. The same facts are available through the
`inspect_deb_package` MCP tool.

## Requirements

- The reader accepts a SysV ar archive whose first bytes are `!<arch>\n`.
  Anything else is refused before control or data members are walked.
- Control fields and relationship alternatives are parsed from the control
  member. Missing optional fields stay null.
- Maintainer scripts are observed by interpreter line and byte length only.
  Script text is not returned and is never executed.
- gzip, Zstandard, xz, and uncompressed control/data members are decoded.
  bzip2 and lzma members are a typed unsupported refusal.
- Malformed or truncated ar/tar input is a typed refusal that retains members
  already parsed. Oversize counts fail against the caller-selected budgets.

## Non-goals

- Installing the package or running maintainer scripts.
- Verifying debsig/dpkg-sig signatures.
- Decoding bzip2 or lzma members.
- Hashing data.tar contents against md5sums; the cross-check is path presence
  only.

## Verification

- Synthetic ar/tar fixtures cover a normal package, gzip/zstd/xz/uncompressed
  members, truncated and oversized xz control, missing optional fields, bad
  ar magic, a truncated member, a tar checksum failure, and oversize counts.
- CLI, MCP, absolute-path, and decimal-argument boundary contracts have their
  own tests.
