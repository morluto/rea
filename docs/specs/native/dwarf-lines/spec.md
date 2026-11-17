# DWARF line-number program inspection

## Problem and outcome

`inspect_dwarf_units` decodes compile-unit headers and `DW_AT_stmt_list` offsets,
and `inspect_elf_debug_link` locates separate `.debug` files, yet REA has no
offline reader for `.debug_line` itself. Determining which source files,
directories, and DWARF 5 MD5 file digests belong to a native binary, or mapping a
virtual code address (such as an export, unwind FDE, or core crash PC) back to
`file:line:column`, currently requires opening a full disassembler or running an
external tool such as GNU `objdump -WL` or `llvm-dwarfdump` that is absent on
some hosts and produces unstructured text outside Evidence.

This feature adds `inspect_dwarf_lines` and `inspect-dwarf-lines`, plus the
`dwarf-lines` view in `inspect_analysis_view`. It decodes DWARF 2 through 5
line-number programs offline from one explicit local ELF, Mach-O, or PE image
without executing the target or launching external tools.

[DWARF line programs](../../../guides/native/dwarf-lines.md) describes the
current behavior and limitations. This directory is the feature specification,
implementation plan, and task list. The guide does not replace these files.

## Requirements

1. The image is a local ELF, Mach-O, or PE file, read through the stable
   artifact read. A universal Mach-O requires `architecture`; the parameter is
   rejected for every other image. `.dSYM` bundles are not opened directly; pass
   the DWARF binary inside the bundle. The target is never executed.
2. Locate `.debug_line`, `.debug_line_str`, `.debug_str`, and
   `.debug_str_offsets` through the shared DWARF section locator, including ELF
   `SHF_COMPRESSED` zlib and zstd sections, legacy GNU `.zdebug_*`, and Mach-O
   `__zdebug_*` zlib sections under the shared `256 MiB` decompressed-section
   allowance.
3. Frame DWARF 2 through 5 line-number programs (32-bit and 64-bit initial
   lengths) either across the entire `.debug_line` section or starting at one
   caller-selected `program_offset` (such as a `DW_AT_stmt_list` value from
   `inspect_dwarf_units`).
4. Decode DWARF 2–4 directory and file tables (`include_directories`, 1-based
   `file_names` with directory index, mtime, and size, plus `DW_LNE_define_file`
   entries) and DWARF 5 format-driven `directory_entry_format` and
   `file_name_entry_format` tables (`DW_LNCT_path`, `DW_LNCT_directory_index`,
   `DW_LNCT_timestamp`, `DW_LNCT_size`, `DW_LNCT_MD5`, `DW_LNCT_LLVM_source`),
   resolving `DW_FORM_string`, `DW_FORM_strp`, `DW_FORM_line_strp`,
   `DW_FORM_strx`/`strx1..4`, `DW_FORM_udata`/`sdata`/`data1..16`, and
   `DW_FORM_indirect`.
5. Execute the DWARF 2–5 line-number state machine: extended opcodes
   (`DW_LNE_end_sequence`, `DW_LNE_set_address`, `DW_LNE_define_file`,
   `DW_LNE_set_discriminator`), standard opcodes (`1..12`, plus skipping
   unrecognized opcodes by `standard_opcode_lengths`), and special opcodes
   including DWARF 4+ `maximum_operations_per_instruction` / `op_index`.
6. Detect unapplied ELF `ET_REL` relocations targeting `.debug_line` (or related
   DWARF debug sections). On unapplied `ET_REL` line tables, keep relocated
   DWARF 5 string-table references `unresolved` (`DW_FORM_line_strp`,
   `DW_FORM_strp`, `DW_FORM_strx*`), mark `addresses_unresolved: true`, and
   report any `addresses` query as `unapplied_relocation` rather than treating
   relocation placeholders (`0x0`) as linked addresses.
7. Optional `addresses` (`0x...`, up to 64 distinct addresses) resolves each
   requested virtual address against contiguous `[row.address, next_row.address)`
   spans (preserving co-located location-view rows at the same PC) and returns
   an explicit status: `resolved`, `not_found`, `unapplied_relocation`, or
   `incomplete` (when line-program coverage is partial so absence is unknown).
8. Bound file bytes (`64 MiB` default, `512 MiB` max), retained `programs`
   (`max_programs`: `256` default, `16,384` max), retained `rows` (`max_rows`:
   `4,096` default, `65,536` max, `0` permitted to omit raw rows), decoded string
   bytes (`64 KiB` per string, `16 MiB` total retained string budget), and
   shared state-machine opcode steps (`2,097,152`). When `max_programs`,
   `max_rows`, or the opcode step budget stops full matrix retention, set
   `coverage.status` to `partial` with the reason; `max_rows: 0` leaves
   `coverage` complete for program/file/address inspection while explicitly
   stating rows were omitted in `limitations`.
9. `detail: "summary"` retains the complete Evidence in the session (or
   `--evidence_output` on the CLI) and returns counts and coverage.
   `inspect_analysis_view` with `kind: "dwarf-lines"` pages `programs`,
   `directories`, `files`, `rows`, `address_matches`, and `issues` with
   `source_index` preserved.
10. MCP requires an absolute path via `absoluteLocalPathStringSchema`; CLI
    resolves relative paths against the working directory. Target-derived paths
    and file names are untrusted.

## Acceptance

- Parser unit tests cover DWARF 2, 3, 4, and 5 headers, 64-bit DWARF, big- and
  little-endian containers, compressed `.debug_line`, `DW_LNE_define_file`,
  `DW_LNE_set_discriminator`, `op_index` VLIW advances, unknown standard/extended
  opcodes, DWARF 5 MD5 digests, `DW_FORM_line_strp`/`strx*`, `ET_REL` unapplied
  relocations, truncated/malformed programs, `program_offset` selection, address
  interval lookups, and budget ceilings.
- Domain, view, service, CLI acceptance, filesystem boundary, and MCP boundary
  tests exercise schemas, summary delivery, `inspect_analysis_view` paging,
  universal Mach-O slice selection, and cancellation.
- Cross-check compiled C ELF binaries (DWARF 2, 3, 4, 5, compressed, `-O2`,
  and `-gdwarf64`) against `readelf --debug-dump=rawline` / `decodedline`.

## Out of scope

- Child DIEs, types, variable location expressions, or inline call-site DIE
  trees (`.debug_info`).
- Following `.dwo`, `.gnu_debuglink`, or build-id debug files automatically.
- Applying `ET_REL` relocations or opening `.dSYM` bundle directories.
- Source-file reads from the host filesystem or target execution.
