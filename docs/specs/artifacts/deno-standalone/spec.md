# Deno compile executable inventory and extraction

## Problem and outcome

`deno compile` embeds an application's metadata, virtual filesystem and remote
modules in a section of a native Mach-O, ELF or PE runtime. REA inventories such
a file as an ordinary native binary, so the embedded application stays hidden.
Let `inspect-artifact` / `inspect_artifact` report the file as root format
`deno-standalone` and `extract-artifact` write its embedded files through the
existing safe output tree, without running the executable or the Deno runtime.

## Requirements

- Recognize the Deno 2.9.8 / libsui 0.16.4 carriers: a Mach-O `__SUI` section
  named `d3n0l4nd`, an Intel Mach-O `<~sui-data~>` trailer, an ELF `PT_NOTE` or
  `SHT_NOTE` owned by `SUI` with type `0x53554901` and descriptor name
  `d3n0l4nd`, and a PE `RT_RCDATA` resource named `D3N0L4ND`. Other layouts,
  including older eszip trailers, are `unsupported`.
- Report root metadata: carrier, embedding, entry point, argv, V8 flags,
  permission options, unstable configuration, application name, self-extracting
  marker, virtual-filesystem case sensitivity and npm snapshot byte length. Keep
  the compiler version unknown, because the metadata JSON has no version field.
- Report each virtual file as one occurrence with logical path, size and SHA-256,
  and its transpiled output, CJS export analysis and source map as separate
  occurrences with the same `index` and their own `role`.
- Keep logical paths safe and unique: unsafe, deep, colliding or over-long names
  (255-byte component, 512-byte path, including `.deno-*` suffixes) use indexed
  `deno-vfs/<index>` or `deno-remote/<index>` paths and retain the original
  spelling when it fits the name allowance. Percent-encode colons, backslashes
  and control characters in remote specifiers and keep the original in
  `source_path`. Never follow symlink targets.
- Retain `Metadata.env_vars_from_env_file` values and `ca_data` bytes in local
  Evidence with their counts and byte lengths, say so in the inventory
  limitation, and do not write them as extracted files.
- Report a virtual filesystem that cannot be listed as `vfs_listing:
  unsupported` with unknown coverage while remote modules still extract.
- Claim a file only after confirming the carrier name. A malformed table before
  confirmation keeps the native inventory; a confirmed section that cannot be
  parsed fails closed. Side-by-side trailers with different bytes fail closed.
- Bound metadata, header, table, specifier, remote body, virtual-filesystem
  record, depth, retained-unit and retained-byte work with named allowances,
  documented in [limits and recovery](../../../design/limits-and-recovery.md#deno-compile-sections).

## Acceptance

Synthetic fixtures cover every carrier, nested and side-by-side Intel trailers,
malformed and duplicate declarations, path indexing and encoding, unlistable
virtual filesystems, remote modules, npm snapshots and `ca_data`. Boundary tests
cover CLI inventory/extraction and MCP `inspect_artifact`. A real Deno 2.9.8
compile of the host and Linux, Windows and Intel macOS targets is inspected and
extracted by `npm run verify:deno:standalone` without running the output
([verification record](../../../verification/deno-standalone-2026-10-31.md)).

## Out of scope

Running the target, decoding npm snapshots, downloading remote modules,
withholding embedded environment values by default, and layouts other than Deno
2.9.8.
