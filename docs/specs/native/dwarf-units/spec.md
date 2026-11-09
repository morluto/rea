# DWARF compile-unit inspection

## Problem and outcome

Learning what a native binary was built from currently needs a deep provider or
GNU objdump through `inspect_with_objdump`, which returns `-W` text the caller
has to parse. Add `inspect_dwarf_units` / `inspect-dwarf-units`, a built-in
reader of DWARF 2 through 5 compile units in one selected local ELF, Mach-O or
PE image. It returns structured unit facts with no provider installed and never
executes the target.

## Requirements

- Read compile-unit headers and the unit-level DIE only. Each unit reports
  version, unit type when the header has one, address size, `name`,
  `comp_dir`, `producer`, language code and DWARF 5 language name, `dwo_name`
  (`DW_AT_dwo_name` or `DW_AT_GNU_dwo_name`), `stmt_list` and whether
  `DW_AT_low_pc` is present.
- Each attribute carries an explicit `present`, `absent`, `unresolved` or
  `unknown` state. A value that cannot be trusted is never returned as a fact.
- Locate `.debug_info`, `.debug_abbrev`, `.debug_str`, `.debug_line_str` and
  `.debug_str_offsets` by container. Mach-O sections are read only from the
  `__DWARF` segment, by file range rather than VM mapping. Decompress ELF
  `SHF_COMPRESSED` zlib and zstd, and GNU `.zdebug_*` and Mach-O `__zdebug_*`
  zlib, within a fixed `256 MiB` decompressed allowance; a larger declared
  size fails the call.
- Bound DWARF 5 `strx` indexes to their `.debug_str_offsets` contribution and
  apply `DW_AT_str_offsets_base` regardless of attribute order. Decode chained
  `DW_FORM_indirect` within the unit. An unknown form becomes a unit issue that
  names the form code.
- Identify ELF relocation sections by type and `sh_info` target. In an ET_REL
  image with unapplied debug relocations, relocated fields stay `unresolved`;
  when `.debug_abbrev` holds more than one table, `abbrev_offset` is null, the
  unit reports `unapplied_relocation` and its DIE is not read.
- Page units with `offset` and `limit` (default `32`, maximum `256`). Bound the
  walk (`100,000` units), abbreviation entries (`8,192`) and attributes
  (`256`), retained string bytes (`64 KiB`), unit issues (`32`) and the input
  read (`512 MiB`). Decompression attempts and abbreviation parsing share
  aggregate work allowances.
- Report `coverage.status` as `complete`, `partial` with a reason, or
  `no_debug_info`. `no_debug_info` does not establish that a separate debug
  file is absent; ELF and PE limitations name whether `.gnu_debuglink` was
  observed. A `.dwo` object is `partial` because `.debug_info.dwo` is not read.
- A universal Mach-O requires `architecture`; the value is rejected for every
  other image. MCP requires an absolute path.

## Acceptance

Unit, provider, boundary, MCP and CLI acceptance tests cover DWARF 2 through 5,
64-bit offsets, compressed sections, split skeletons, unknown forms, truncated
units, abbreviation budgets, relocatable objects and the decompressed-size
allowance. `npm run verify:dwarf-units` builds owned C fixtures and compares
every unit's version, name, comp_dir, producer and dwo_name with
`llvm-dwarfdump` across Mach-O objects and linked ELF and PE images, and checks
fixed expectations for an ELF relocatable object, an `ld.lld -r` merge and a
`.dwo` object. The [verification record](../../../verification/dwarf-units-2026-10-31.md)
lists the variants run and those skipped.

## Out of scope

Line tables, types, functions, child DIEs and location expressions; following
`.dwo` files, `.gnu_debuglink` or build-id links; decoding `.gnu_debuglink`
contents or GNU build-id notes; applying relocations; opening `.dSYM` bundles;
and target execution.
