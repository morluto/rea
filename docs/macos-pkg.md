# macOS flat installer packages

`inspect-artifact` and `extract-artifact` read local macOS flat installer
packages (`.pkg` files whose bytes start with `xar!`) without expanding them
with `pkgutil`, running installer JavaScript, or verifying the XAR signature.
The same domain facts and artifact reader serve CLI and MCP. The reader is
portable: Linux and Windows hosts inventory the same bytes as macOS.

A flat package is an XAR archive. The 28-byte header names the zlib-compressed
table of contents (TOC). The TOC XML lists each stored file's name, type, heap
offset, archived and extracted sizes, encoding, and the checksum values the
archive recorded. REA reports those recorded checksums; it does not treat them
as verified identities. Heap ranges that extend past the file are refused and
omitted; other TOC files stay visible.

A product archive carries a `Distribution` document plus nested
`*.pkg/PackageInfo` component packages. A component package carries
`PackageInfo` at the archive root. Inventory reports title, `pkg-ref`
identifiers, versions and `installKBytes`, the choices outline,
`allowed-os-versions`, and whether `installation-check` / `volume-check`
scripts are present. Script bodies are reported by byte length only and are
never executed. Each `PackageInfo` contributes identifier, version,
install-location, auth, `postinstall-action`, bundle entries, and declared
preinstall/postinstall names.

`Scripts` and `Payload` members that are gzip-compressed odc cpio (`070707`)
are expanded into nested occurrences (path, mode, uid/gid, size, symlink
target). `preinstall` and `postinstall` presence is explicit. Script bytes are
not executed. `pbzx` (xz-chunked) payloads keep the stored `Payload` member
and record a typed unsupported-compression refusal; Distribution, PackageInfo
and Scripts inventory still appear. `Bom` is reported by presence and size
only.

When the TOC names a signature or x-signature, inventory reports the
algorithm and the embedded certificate subject's and issuer's common names
through `node:crypto` `X509Certificate`. Verification is always
`not_verified`.

Malformed or truncated input keeps what was safely read: a short header, a TOC
that extends past EOF, a zlib inflate failure, an out-of-bounds heap range, a
declared extracted-size that disagrees with the decoded member, or garbage
cpio headers become named refusals on the root metadata rather than silent
zeros. Counts above the fixed TOC and cpio allowances fail as a capacity
limit.

Extraction writes stored XAR files and expanded gzip-cpio members into the
existing contained output tree. pbzx payload contents are not decoded.

## Bounded work and retained facts

These are resource policies, not format maxima. The compressed TOC is limited
to 16 MiB and the uncompressed TOC XML to 64 MiB. A TOC may declare at most
4,096 files. One gzip-decoded Scripts or Payload archive is limited to 64 MiB
and 4,096 cpio members. Distribution and PackageInfo documents used for
metadata are limited to 1 MiB. A TOC extracted-size above the named allowance
for that member is refused without inflating. A decoded length that disagrees
with the TOC is `extracted-size-mismatch`. Extraction stream-decodes gzip/zlib
XAR members with `artifact_limits.expanded_bytes` (the same expansion budget
as ZIP/Bun/Deno/Godot). Every component `Scripts`/`Payload` is expanded until
that budget is exhausted; remaining component archives are named and coverage
is unknown. Member streams use 64 KiB chunks. Parsed facts are cached for one
reader. Close joins active member pipelines before releasing the descriptor.

Prefer a retained summary when only a few facts are needed:

```sh
rea inspect-artifact installer.pkg --detail summary \
  --evidence_output installer.evidence.json --json
rea extract-artifact installer.pkg --json
```

With MCP, `inspect_artifact` with `detail: "summary"` retains the complete
Evidence. Coverage and limitations remain attached.

## Verification scope

Synthetic XAR fixtures cover a product archive, a component package, a signed
TOC with an embedded certificate, a pbzx payload stub, truncated headers, TOC
lengths past EOF, inflate failures, heap ranges past the heap, garbage cpio
headers, and an oversize TOC file count. Compiled CLI and MCP tests inspect
and extract the product-archive fixture. `inspect-artifact --json` was also
run against the public MacPorts 2.10.5 Sequoia installer
(`https://github.com/macports/macports-base/releases/download/v2.10.5/MacPorts-2.10.5-15-Sequoia.pkg`,
SHA-256 `574662c46ae07dc06f5b1bc7fd517c9729163cc3c4a91027a011f794dc46d65c`):
product archive, gzip cpio Payload and Scripts, Bom by size, CMS signature
named and not verified. No Apple `pkgbuild` / `productbuild` package was
produced on this host. XAR signatures are not verified. pbzx/xz payloads and
Bom files are not decoded. Installer JavaScript is never evaluated.
