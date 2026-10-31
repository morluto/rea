# ELF note tables

`inspect_elf_notes` / `inspect-elf-notes` answers whether one selected local
ELF32/ELF64 image declares `PT_NOTE` program headers or `SHT_NOTE` sections,
which note owners and types those tables store, which GNU build-id or ABI-tag
fields those notes carry, and which package or dlopen dependencies FDO notes
declare. It reads the file without executing it and
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

For GNU notes, `gnu.build_id_hex`, `gnu.abi_tag`, or `gnu.gold_version` are
filled when the descriptor matches that type. Other owners keep `gnu` null.

For `FDO` notes, `fdo.metadata` holds the JSON from
[package metadata](https://uapi-group.org/specifications/specs/package_metadata_for_executable_files/)
(`fdo_packaging_metadata`, type `0xcafe1a7e`, usually `.note.package`) or
[dlopen metadata](https://uapi-group.org/specifications/specs/elf_dlopen_metadata/)
(`fdo_dlopen_metadata`, type `0x407c0c0a`, usually `.note.dlopen`) notes:

```json
{
  "type_name": "fdo_packaging_metadata",
  "fdo": {
    "metadata": {
      "type": "rpm",
      "name": "coreutils",
      "version": "9.10-5.fc44",
      "architecture": "x86_64",
      "osCpe": "cpe:/o:fedoraproject:fedora:44"
    },
    "issue": null
  }
}
```

Packaging metadata must be a JSON object and dlopen metadata a JSON array,
stored as NUL-terminated UTF-8 followed only by NUL padding. A descriptor that
breaks those rules keeps its entry, hash, and location, with `metadata` null
and `issue` naming the rule. Descriptors beyond the report's 64 KiB FDO decode
allowance are not decoded and report the allowance the same way. Keys are not checked against the specifications.
This metadata is what the producer declared; it is not verified against a
package database or the libraries a loader would open. Other FDO note types and
other owners keep `fdo` null.

`PT_NOTE` and `SHT_NOTE` are examined independently. The same file range may
appear twice when both tables declare it.

A missing table list is observed absence of those declarations. It is not proof
the image never carried notes in another container or overlay.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum). At most
32 note entries are examined by default across every table. Retained note
names, section names, and GNU descriptor text share a scan budget based on
the source bytes plus any decoded section-name table, capped at
`max_file_bytes`. The raw source and decoded table must also fit together
within that ceiling. If admission fails, the error reports the required
`max_file_bytes`; raising it can admit the decoded table up to the operation's
512 MiB maximum. Once admitted, raising that setting does not increase the
scan budget for the same source and decoded names. Repeated table ranges count again. Each descriptor range is hashed once,
each GNU version's trailing NUL run is scanned once, and each FDO descriptor is
decoded once; none of those walks may exceed that byte ceiling. Retained FDO
JSON text counts against the shared budget for every entry that repeats it.
FDO decoding shares a 64 KiB allowance across the report, because a decoded
JSON tree can take about 50 times its source bytes in memory. Each distinct
descriptor's full size counts once, in table order; a range repeated by
another table reuses its decode. Malformed ELF headers, truncated header
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
