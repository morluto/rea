# Packages and archives

Read only the sections needed for the selected task.

- [Packages and extraction](#packages-and-extraction)
- [Godot PCK](#godot-pck)
- [Bun standalone executables](#bun-standalone-executables)

## Packages and extraction

For PyInstaller executables, the CArchive is the application layer; the native
bootloader is only its prefix. Prefer summary delivery for large inventories,
then retained inventory views with selected member fields/pages. Runtime options
are metadata, not files. Compact delivery still inventories and hashes members.
A small complete inventory can cost less than extra calls and schemas. See the
[Python packaged applications guide](https://github.com/morluto/rea/blob/main/docs/python-packaged-applications.md).

Use `inspect_artifact` for application bundles, archives, ZIP/APK/IPA/MSIX/AppX,
ASAR, or DMG inputs when the artifact graph and findings help answer the
question. It returns the complete artifact graph inline. Cite graph manifest
IDs when using them.

For an IPA or a macOS `.app`, ZIP, or DMG, pass the inventory Evidence to
`project_apple_application_graph`. It reports application roots and nested
bundles by path convention: app extensions, XPC services, frameworks, login
items, system and driver extensions, and plug-ins. It also lists privileged
helpers, launchd plists, symlinks, and each bundle's `info_plist_path` and
executable candidates. Roles are path conventions, not parsed plists; read the
listed plists with `inspect_plist`.

After `open_binary` on a `.app` or Mach-O, use `trace_dylib_resolution` to see
which file each `@rpath`, `@loader_path` and `@executable_path` load reaches for
every executable in the bundle. It also lists missing or weak loads and earlier
`@rpath` candidates that are absent. Narrow large bundles with `roots` or
`architecture`. System paths stay undetermined because the dyld shared cache
provides them.

Use `extract_artifact` when materialized files from a supported format are needed.
It extracts the active target and accepts optional `integrity_policy`; see the [MCP contracts](https://github.com/morluto/rea/blob/main/docs/reference/mcp-contracts.md).
It materializes all regular files into a fresh temporary directory chosen by
REA. Symlinks and encrypted entries are inventory facts, not extractable files.
The result reports the materialized directory; callers do not choose the
destination. No separate permission grant is needed.

For classic iNES cartridges, `open_binary` recognizes the byte signature without
an executable architecture. `inspect_artifact` retains header facts and each
PRG/CHR file unit's offset, length and SHA-256; its nested inventory's
`ines.reconstruction` verifies the actual ordered region bytes against the
whole-file digest. Extraction includes the original header, optional trainer
and uninterpreted trailing bytes. These file units are not mapper/CPU bank
maps. NES 2.0, UNIF, dirty legacy headers and truncated payloads are explicitly
refused. No emulator or 6502 analysis is performed. See the
[iNES guide](https://github.com/morluto/rea/blob/main/docs/ines-containers.md).

Native DMG traversal automatically uses a read-only mount on supported macOS
hosts, with an owned temporary mount directory and cleanup. It needs no approval
flag. Unsupported hosts or mount failures remain explicit limitations; do not
claim child inventory when only root identity is available. DMG extraction is
unavailable through `extract_artifact`. To access DMG files on macOS, create a
read-only mount with your own tools, select files from that mount for analysis,
and detach the mount you created when finished. REA's inspection mount is
temporary, not a retained export of the image's contents.

Use `inspect_byte_entropy` to triage high- and low-entropy ranges before extraction.

## Godot PCK

For a standalone PCK, `open_binary` then `inspect_artifact` with
`detail: "summary"` retains the complete static inventory. Use the returned
`parent_evidence_id` with `inspect_analysis_view` inventory occurrences filtered
by exact `logical_paths` or `occurrence_ids`, and join `artifact_id` to nodes
filtered by `artifact_ids`. Select only needed fields; identity links remain.
Prefer `inspect-artifact --detail summary --evidence_output PATH` for CLI tasks;
the same CLI discovers embedded packs via their EOF trailer without opening a
native analysis provider. Normal native opening remains unchanged.

Distinguish declared MD5 from observed SHA-256 and graph/page completeness from
`source_coverage`. Encrypted directories and sparse bundles have unknown entry
coverage; encrypted members have unknown content identity. An empty filtered
page cannot prove absence in unknown coverage. Retained views are historical,
not fresh filesystem checks. No decryption, Godot resource decoding, GDScript
decompilation or target execution is provided. See
[Godot PCK](https://github.com/morluto/rea/blob/main/docs/godot-pck.md).

UnityFS AssetBundle containers (`.bundle`, `.ab`, YooAsset packages and other
byte-identified files) list `CAB-*` SerializedFiles and `.resS` members with
header and node facts; none/LZ4/LZ4HC member blocks stream on demand. Bundles
declaring asset-bundle encryption keep header facts with unknown directory
coverage; LZMA member bytes retain named occurrences with unavailable hashes.
Virtual member offsets are not physical carrier locations. Format 6–8 readers
cache one decoded block and support retained filtered/paged views. No
decryption or SerializedFile object decoding is provided. See
[UnityFS](https://github.com/morluto/rea/blob/main/docs/unityfs.md).

WeChat mini-program packages (`.wxapkg` files with `0xBE`/`0xED` marks) list
members with declared names and absolute carrier offsets; member bytes are
stored verbatim. `V1MMWX` PC-client packages report `encrypted` directory
status with unknown coverage and are refused on extraction; no decryption is
attempted. See
[wxapkg](https://github.com/morluto/rea/blob/main/docs/wxapkg.md).

U-Boot legacy uImages use the same inspection/extraction workflows. Prefer a
retained summary and selected inventory views for header facts or component
IDs. Header addresses/CPU/OS are declarations; payloads remain as stored.
Multi-file components retain their aligned physical ranges; the full payload
is also materialized. Unknown name text retains its original 32 bytes. See
[U-Boot uImage](https://github.com/morluto/rea/blob/main/docs/uimage.md).

## Bun standalone executables

A `bun build --compile` executable stores its module graph in Mach-O
`__BUN,__bun`, a PE or ELF `.bun` section, or an appended trailer.
`open_binary` then `inspect_artifact` reports root format `bun-standalone` with
the carrier, structural layout, module count, entry point, raw flags and
compile exec-argv; each module keeps its `/$bunfs/...` source name, loader,
encoding, sizes and SHA-256, with sourcemap, bytecode and module-info regions as
separate children. Use summary root metadata `entry_point_logical_path` as the
exact inventory `logical_paths` selector, then read the selected content node by
its artifact ID; the reader owns virtual-name normalization and indexed fallback. `extract-artifact` writes stored contents through the safe
output tree; route extracted JavaScript to `analyze_javascript_application`.
Layout labels describe record shapes, not a detected compiler version; unknown
or ambiguous layouts are unsupported. Bytecode is retained, not decoded, and the
executable is never run. See
[Bun standalone executables](https://github.com/morluto/rea/blob/main/docs/bun-standalone.md).
