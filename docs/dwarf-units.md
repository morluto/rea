# DWARF compile units

`inspect_dwarf_units` / `inspect-dwarf-units` reads compile-unit headers and
the unit DIE from one selected local ELF, Mach-O, or PE image. It covers
DWARF 2 through 5, including compressed ELF sections. It does not execute the
image and does not require a disassembler.

```bash
rea inspect-dwarf-units /absolute/path/to/program --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path:

```json
{
  "name": "inspect_dwarf_units",
  "arguments": { "path": "/artifacts/program" }
}
```

A universal Mach-O needs `architecture` (`x86`, `x86_64`, `arm`, or `arm64`).
The same value is rejected for every other image. A `.dSYM` bundle is not
opened. Pass the DWARF file inside the bundle.

## Observations

Each call returns the artifact path, SHA-256, and byte length, the container
`format`, and `sections` for `.debug_info`, `.debug_abbrev`, `.debug_str`,
`.debug_line_str`, and `.debug_str_offsets` when those sections are
file-backed. Section rows keep the stored name, file offset, stored size, and
`compression` (`none`, `zlib`, or `zstd`). ELF `SHF_COMPRESSED` zlib and zstd
payloads, and legacy GNU `.zdebug_*` and Mach-O `__zdebug_*` zlib payloads, are
decompressed within a fixed allowance. A declared size above that allowance
fails the call. Mach-O sections are read only from the `__DWARF` segment.
`omissions` gives one row per section name and reason, with a count when
several sections share it.

`units` lists the requested page. `offset` and `limit` select that page.
`total_units` counts framed units in this file, up to the walk cap. Each unit
row gives its offset inside decompressed `.debug_info`, DWARF version, unit
type when the header has one, address size, name, `comp_dir`, producer,
language code and DWARF 5 language name, `dwo_name`, `stmt_list`, and whether
`DW_AT_low_pc` is present. `file_offset` is null when `.debug_info` is
compressed. Per-unit decode problems are `issues`. The walk continues when the
unit length still frames the next unit.

## Coverage and limits

`coverage.status` is `complete` when every framed unit was visited. Gaps inside
a visited unit stay in that unit's `issues`, so `complete` does not mean every
fact resolved. `partial` means a later length could not frame the next unit, the
walk cap was reached, a declared `.debug_info` could not be decoded, or a further
`.debug_info` section was not read. A `.dwo` object is `partial` because its
`.debug_info.dwo` is not read. `no_debug_info` means this file declares no
`.debug_info`, or declares one that stores no bytes. That does not establish
that a separate debug file is absent. For ELF and PE, the limitations then name
whether `.gnu_debuglink` was observed. `.gnu_debuglink` contents and GNU build-id
notes are not decoded here.

Child DIEs, types, functions, line tables, and location expressions are not
read. An unknown DWARF form becomes a unit issue that names the form code.
`DW_AT_str_offsets_base` is applied to `strx` indexes in the same DIE
regardless of attribute order. `dwo_name` reads `DW_AT_dwo_name` and the GNU
`DW_AT_GNU_dwo_name`.

An ET_REL image whose debug relocations are unapplied holds placeholders in its
relocated fields. `DW_AT_stmt_list`, `DW_AT_str_offsets_base`, and `DW_FORM_strp`,
`DW_FORM_line_strp`, `DW_FORM_strx`, and `DW_FORM_GNU_str_index` values stay
unresolved. The abbreviation offset selects a table only when `.debug_abbrev`
holds one table. Otherwise, as in `ld -r` output, `abbrev_offset` is null, the
unit reports `unapplied_relocation`, and its DIE is not read.

The [verification record](verification/dwarf-units-2026-10-31.md) lists the
compiled variants compared with a DWARF dumper.
