# Inventory macOS flat installer packages offline

## Problem and outcome

A `.pkg` whose bytes start with `xar!` is classified as format `pkg`, but
`artifactFormats.ts` declared `absentInventory: "platform"` with no reader.
Every host, including macOS, reported only the root hash and the limitation
that child inventory required a native adapter. Analysts could not see
Distribution/PackageInfo identity, installer scripts, or the files a payload
would write.

Give the already-classified `pkg` container a portable, read-only XAR reader
so `inspect-artifact` / `inspect_artifact` report those facts on any host, and
`extract-artifact` writes stored members the sibling container readers already
support.

## Requirements

- Parse the XAR header (magic, header size, version, TOC compressed and
  uncompressed lengths, checksum algorithm) and the zlib-compressed TOC XML.
- Report each TOC file's name, type, data offset/length/size, encoding, and
  recorded archived/extracted checksums. Check heap ranges against the file.
- Report whether the TOC carries a signature or x-signature, the algorithm,
  and embedded certificate subject/issuer common names. Do not claim the
  signature is valid.
- Distinguish product archives (`Distribution`) from component packages
  (`PackageInfo`). Parse title, pkg-ref ids/versions/installKBytes, choices,
  allowed-os-versions, and installation-check/volume-check script presence by
  length only.
- Expand gzip odc cpio `Scripts` and `Payload` members into a bounded file
  inventory, including every component in a product archive until the
  expansion budget is exhausted. Name skipped component archives and leave
  coverage unknown. Flag `preinstall`/`postinstall`. Never execute script
  bytes.
- Cap zlib/gzip decode by the named allowance for that use (1 MiB metadata
  XML, 64 MiB Scripts/Payload, `artifact_limits.expanded_bytes` for
  extraction). Refuse a TOC extracted-size above that allowance without
  inflating. A decoded length that disagrees with the TOC is a named
  `extracted-size-mismatch` refusal. `open()` stream-decodes gzip/zlib
  members against the expansion budget.
- Report `pbzx` payloads with a typed unsupported-compression refusal while
  keeping Distribution, PackageInfo and Scripts. Report `Bom` by presence and
  size only.
- Malformed input (bad magic, TOC past EOF, inflate failure, heap overflow,
  cpio garbage, oversize counts) must produce typed refusals that keep what
  was safely read.
- Reuse `inspect-artifact` rather than a dedicated command: `pkg` is already
  a classified container.

## Acceptance

Synthetic XAR fixtures cover a product archive, a multi-component product
archive, a component package, a signed TOC, a pbzx payload, truncated
headers, TOC-past-EOF, inflate failure, heap overflow, garbage cpio, an
oversize TOC, an oversize declared gzip member, and a declared-vs-actual
extracted-size mismatch. Domain, reader, CLI acceptance and MCP boundary
tests exercise those cases. A public MacPorts 2.10.5 Sequoia flat package was
inventoried through the compiled CLI; Apple `pkgbuild` output from this host
remains unverified.

## Out of scope

XAR signature verification, pbzx/xz payload decode, Bom decode, installer
JavaScript evaluation, and a dedicated `inspect-pkg` command.
