# ELF unwind function ranges

## Problem and outcome

A stripped ELF often has no symbol table, but its `.eh_frame` still names the
start and end of nearly every function so exceptions can unwind. REA can list
symbols and disassemble with a provider, but it cannot recover function
boundaries from unwind tables, so an agent without a disassembler has no
function list for a stripped binary.

This feature adds `inspect_elf_unwind_ranges` and
`inspect-elf-unwind-ranges`. They read `.eh_frame` and `.eh_frame_hdr` from one
selected local ELF32 or ELF64 image and list the function ranges those tables
name, without executing the image.

[ELF unwind function ranges](../../../guides/native/elf-unwind-ranges.md) describes the
current behavior and limitations. This directory is the feature
specification, implementation plan and task list. The guide does not replace
these files.

## Requirements

1. `.eh_frame` comes from section headers, or from `PT_GNU_EH_FRAME` when
   section headers are missing. The source and examined file range are
   reported. `SHT_NOBITS`, out-of-file and truncated tables are `incomplete`.
   Program headers come from the shared section directory, which rejects an
   unreadable program-header table, so a missing `PT_GNU_EH_FRAME` is observed
   absence. An `.eh_frame` located only through the header's `eh_frame_ptr`
   is read no further than the last FDE a decoded search table names. Without
   a usable table it stops at the first undecodable record, including a CIE
   with an unrecognized augmentation and its FDEs, or at the end of
   its `PT_LOAD` without a terminator, and coverage is `incomplete`.
2. CIEs report version, augmentation, alignment factors, return-address
   register, pointer and LSDA encodings, personality, and signal-frame and
   B-key flags. A page returns only the CIEs its ranges name, so CIE output is
   bounded by `limit`, and `coverage.total_cies` counts every decoded CIE.
   CFA programs are counted, not evaluated. A CIE with an
   unrecognized augmentation letter is not decoded, its FDEs are skipped
   with a counted limitation, and coverage is `incomplete`.
3. FDEs become ranges with start, end, size, containing `SHF_ALLOC` section, an exact
   symbol name when one starts at that address, CIE index, LSDA and
   personality, paged by `offset` and `limit`.
4. Encoded pointers follow the `DW_EH_PE` rules. A raw zero is a null pointer.
   Resolved addresses and FDE ends wrap at the ELF32 or ELF64 address width.
   `datarel` in `.eh_frame` resolves against `DT_PLTGOT`, then `.got.plt` or
   `.got`, and an unresolved base leaves the record out with coverage
   `incomplete`. Indirect pointers are not dereferenced: an FDE with an
   indirect initial location is skipped with a counted limitation, and an
   indirect `eh_frame_ptr` does not locate `.eh_frame`. Both leave coverage
   `incomplete`.
5. A 64-bit extended length keeps the `.eh_frame` CIE ID and pointer at 4
   bytes.
6. An FDE with a zero initial location is a discarded function. It is counted
   as examined, not reported, and a limitation gives the count.
7. `.eh_frame_hdr` is decoded and its search table compared with the decoded
   FDEs as `agree`, `disagree` or `unavailable`. The table is read for at most
   `max_ranges` rows and no more rows than its bytes hold. A larger declared
   count makes the header `incomplete` with a limitation.
8. `.debug_frame` presence is reported but not decoded.
9. Budgets bound the file size, CIE and FDE counts, page size and the symbol
   lookup across `.symtab` and `.dynsym`. Only symbols at decoded FDE starts
   are kept, names are decoded only for the returned page, and that text has a
   fixed 16 MiB allowance. Only the first `PT_GNU_EH_FRAME` is read; a
   duplicate one that supplies the header makes coverage `incomplete`. Section and symbol lookups use
   indexes built once per image, so cost does not grow as sections times
   entries. Address translation uses `SHF_ALLOC` sections, then
   `PT_LOAD`; a non-ALLOC section's `sh_addr` is never used.
10. Symbol names, section names and augmentation strings are marked
    target-derived and untrusted. MCP requires an absolute path.

## Acceptance

- Unit tests cover CIE and FDE decoding for both widths and endiannesses,
  pointer encodings, extended lengths, zero pointers, discarded FDEs, header
  agreement and caps, and the GOT base.
- Service tests validate the report shape, including incomplete headers and
  null LSDAs.
- CLI acceptance, filesystem boundary and MCP boundary tests exercise the
  public contract.
- `npm run verify:elf:unwind-ranges` compares the reported FDE starts with
  `readelf` or `llvm-dwarfdump` on a compiled C++ program.

## Non-goals

- Decoding `.debug_frame` or evaluating CFA programs.
- Applying relocations in relocatable objects.
- Following indirect EH pointers.
