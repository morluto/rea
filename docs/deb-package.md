# Debian package inspection

`inspect_deb_package` / `inspect-deb-package` reads one selected local `.deb`
without installing it, running maintainer scripts, or contacting a mirror. It
reports the SysV ar container, parsed control identity and relationships, which
maintainer scripts are present, and a bounded data.tar file inventory.

```bash
rea inspect-deb-package /absolute/path/to/hello_2.03-1_all.deb --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_deb_package",
  "arguments": { "path": "/artifacts/hello_2.03-1_all.deb" }
}
```

## Observations

`ar` records the global `!<arch>\n` magic, each member's stored name, role,
size and file offset, and the `debian-binary` format version. Extra members
that are neither `debian-binary`, `control.tar*`, nor `data.tar*` stay in
`extra_member_names`; they are not guessed as control or data. Only the first
`debian-binary`, `control.tar*`, and `data.tar*` member is read; a later member
with the same role is also listed in `extra_member_names`, is not decoded, and
keeps coverage partial.

`control` holds Package, Version (epoch, upstream, revision), Architecture,
Maintainer, Installed-Size, Section, Priority, Homepage, the Description
synopsis, Source, Multi-Arch, and Essential. Relationship fields
Depends, Pre-Depends, Recommends, Suggests, Conflicts, Breaks, Replaces,
Provides, and Enhances are parsed into groups of alternatives with version
operators and architecture qualifiers. Missing optional fields stay `null`,
not empty lists or empty strings.

`conffiles` and `md5sums` report presence and line counts. Maintainer scripts
(`preinst`, `postinst`, `prerm`, `postrm`, `config`, `triggers`) report only
the interpreter line and byte length. Script text is not returned and is never
executed.

`data_entries` inventories data.tar paths with type, mode, size, owner, and
symlink or hardlink target. `md5sums_cross_check` compares listed md5sums
paths to file entries in that inventory; it does not hash file contents.

gzip, Zstandard, xz, and uncompressed control/data members are decoded
in-process. xz uses `@napi-rs/lzma` under the same `max_control_bytes` and
`max_data_bytes` budgets as gzip and zstd. bzip2 and lzma members are
unsupported. Package signatures (debsig/dpkg-sig) are not verified.

Complete Evidence remains the default. `inspect_analysis_view` can project a
`summary` of identity and counts from retained Evidence without reopening the
`.deb`.

## Failed inspection

A file that is not a Debian ar archive, a member whose declared size runs past
EOF, or a tar header whose checksum fails reports `unsupported_target` with
a `failure_kind` of `malformed` or `truncated`. Members and control facts
already parsed stay on the refusal as partial diagnostics.

A bzip2 or lzma control or data member is `unsupported_target`. An xz member
whose native decoder cannot load on this platform is the same refusal. Truncated
or corrupt xz reports `unsupported_target`. Earlier ar members and a successfully
parsed control archive remain available on that refusal.

Caller-selected budgets (`max_file_bytes`, `max_ar_members`,
`max_control_entries`, `max_data_entries`, `max_control_bytes`,
`max_data_bytes`) fail as `resource_constraint` when exceeded and name the
option that may move.

Fixed reader allowances (4096 bytes for one resolved ar member name, 8 PAX
or GNU extension headers before one tar entry, 65,536 relationship
alternatives across the control file) also fail as `resource_constraint`, not
as invalid input, with the partial report attached. No request option raises
them.

## Relationship to other tools

- `inspect_artifact` recognizes a `.deb` and routes it to
  `inspect_deb_package` without decoding Debian control or data.tar contents.
- Desktop capture of an installed package through `dpkg-deb` is a different
  authority: this reader never launches `dpkg` and never installs the archive.
