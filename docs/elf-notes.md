# ELF note tables

`inspect_elf_notes` / `inspect-elf-notes` answers whether one selected local
ELF32/ELF64 image declares `PT_NOTE` program headers or `SHT_NOTE` sections,
which note owners and types those tables store, and which GNU build-id or
ABI-tag fields those notes carry. It reads the file without executing it and
does not require a disassembler, debug package, or package catalog.

```bash
rea inspect-elf-notes /absolute/path/to/program --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_elf_notes",
  "arguments": { "path": "/artifacts/program" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte length.
`tables` lists each declared note program header or section, including the
section name when a string table is present. Zlib- and Zstandard-compressed
section-name tables are decompressed within the selected file-size budget. An unsupported
compression type leaves section names unknown and adds a limitation; note bytes
remain independently examined. Each `entries[]` item reports owner, type,
descriptor SHA-256, and a hex preview for descriptors of 64 bytes or less.

A section name also stays null when its offset is outside the declared string
table or its bytes lack a NUL terminator. A limitation explains that missing
name. Note coverage remains complete when all declared note tables and entries
were examined; an unavailable section name does not erase those note facts.

GNU decoding requires the four declared owner bytes `47 4e 55 00`, including
the terminator. For those notes, `gnu.build_id_hex`, `gnu.abi_tag`, or
`gnu.gold_version` are filled when the descriptor matches that type.
An owner that only displays as `GNU` retains its raw bytes and descriptor,
with an unknown type name and null `gnu` when its declared bytes differ.

For Linux `CORE` notes, `core.prpsinfo`, `core.file`, `core.siginfo`, or
`core.auxv` are decoded for process arguments and status (`NT_PRPSINFO`), mapped
file memory regions and paths (`NT_FILE`), fault signal and code (`NT_SIGINFO`), and
auxiliary vectors (`NT_AUXV`) across 32-bit and 64-bit images. Other owners or unparsed
notes keep `core` null.

An `NT_FILE` descriptor with nonzero bytes after its declared filenames
retains its raw note evidence and leaves `core` null.

Linux `CORE` decoding requires System V/unspecified (0) or GNU/Linux (3)
OSABI with ABI version zero. An unspecified OSABI alone does not establish
Linux origin. An explicitly different OSABI or ABI version leaves `core` null
and its Linux-specific `type_name` unknown, with a limitation explaining the
profile. Owner/type numbers, descriptor ranges and hashes, GNU-owned notes,
and complete table-examination coverage remain available.

For Android `NT_ANDROID_TYPE_IDENT` (`.note.android.ident`, owner `Android`,
type `1`) notes, `android.android_api` is decoded from both legacy 4-byte
descriptors (where `ndk_version` and `ndk_build_number` remain null) and modern
132-byte or extended NDK descriptors, which also populate `android.ndk_version`
and `ndk_build_number` when their 64-byte slots hold NUL-padded
printable ASCII. Truncated or non-ASCII Android descriptors degrade `android`
to null while preserving the raw descriptor digest and preview, and other
owners keep `android` null.

`PT_NOTE` and `SHT_NOTE` are examined independently. The same file range may
appear twice when both tables declare it.

A missing table list is observed absence of those declarations. It is not proof
the image never carried notes in another container or overlay.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum). At most
32 note entries are examined by default across every table. Retained note
names, section names, GNU descriptor text, core dump string representations, and Android ident strings share a scan budget based on
the source bytes plus any decoded section-name table, capped at
`max_file_bytes`. The raw source and decoded table must also fit together
within that ceiling. If admission fails, the error reports the required
`max_file_bytes`; raising it can admit the decoded table up to the operation's
512 MiB maximum. Once admitted, raising that setting does not increase the
scan budget for the same source and decoded names. Repeated table ranges count again. Each descriptor range is hashed once,
and each GNU version's trailing NUL run is scanned once; neither walk may
exceed that byte ceiling. Malformed ELF headers, truncated header
tables, declared note tables that extend past the file, and truncated
note entries fail without partial success. ELF extended
numbering (`PN_XNUM`, including a section count stored when `e_shnum` is 0) is
unsupported and returns an unsupported-target outcome rather than invalid-input
recovery.

Zstandard section-name tables also use a 128 MiB decoder window limit.

`SHF_COMPRESSED` note sections return `unsupported_target` before their payload
is interpreted or decompressed. Their compression header is storage metadata,
not a note header. The current result requires physical file offsets for each
note and descriptor, which decoded compressed notes cannot provide. This refusal
does not label compressed note storage as malformed or allocate its declared
decoded size. Compressed section-name tables remain supported within the limits
above. Inspect a separately decompressed copy when these notes are needed,
retaining the original artifact for provenance.

This workflow does not execute the image or verify GNU build-id uniqueness
against package catalogs.
