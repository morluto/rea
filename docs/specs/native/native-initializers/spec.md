# Native initializer and finalizer functions

## Problem and outcome

Analysts reviewing a native image need the functions it declares to run before
`main` and at exit, without executing it or opening a disassembler provider.
`inspect_native_initializers` / `inspect-native-initializers` lists the
initializer and finalizer slots of one local ELF or Mach-O image, with each
slot's location, resolved target and how that target was obtained. The
[user guide](../../../guides/native/native-initializers.md) documents the result.

## Requirements

- Accept one local ELF32, ELF64, thin Mach-O or universal Mach-O image. A
  universal Mach-O requires `architecture` to select one slice; other inputs
  reject it. The CLI resolves relative paths; MCP requires an absolute path.
- ELF sources, in order: `DT_PREINIT_ARRAY`, `DT_INIT`, `DT_INIT_ARRAY`, legacy
  `.ctors`, `DT_FINI`, `DT_FINI_ARRAY`, legacy `.dtors`. Without the dynamic tag,
  fall back to `SHT_*_ARRAY` sections or `.init_array*` / `.fini_array*` /
  `.preinit_array` names. Mach-O sources are sections typed
  `S_MOD_INIT_FUNC_POINTERS`, `S_INIT_FUNC_OFFSETS` and
  `S_MOD_TERM_FUNC_POINTERS`.
- Resolve values through RELATIVE and RELR dynamic relocations, then section
  REL / RELA records for slots no dynamic relocation covers, then the stored
  word when relocation coverage is known. Mach-O uses chained-fixup rebases,
  `LC_DYLD_INFO` rebases (reported separately), `MH_OBJECT` section
  relocations and `__init_offsets` image-base offsets. Anything else is
  `unresolved`, never a stored zero.
- Relocation coverage is per slot. A slot that a dynamic or section relocation
  only partly overwrites or writes more than once is `unresolved`, and so is an
  absolute relocation against an `STT_GNU_IFUNC` resolver. On 32-bit ARM the
  Thumb bit is cleared for target section and file-offset lookup only. A slot with no
  relocation found is `unresolved` when a dynamic table, or a section table
  that could reach it, was not fully read; such a `.ctors` slot is not dropped
  as a sentinel. A `COPY` relocation covers the bytes of its symbol's size and
  a TLS descriptor two words. The size comes from the dynamic symbol table for
  a dynamic record and from the table's linked symbols for a section record of
  a linked image; an unread size leaves coverage unknown. A linked image's
  section record that writes memory with no file bytes covers only the slots
  it overlaps there when its extent is established, by a fixed width or a
  `COPY` size, and otherwise leaves its table not fully read. A
  linked image's non-`SHF_ALLOC` relocation sections were
  applied at link time and are not reapplied. A Mach-O stored pointer word is
  used only when no undecoded bind stream or external relocation could
  replace it.
- Relocatable objects (`ET_REL`) report section-relative offsets and say so.
- `.ctors` / `.dtors` sentinels are 0 and all ones at the image's pointer width;
  they are omitted and counted in a limitation.
- `DT_INIT` / `DT_FINI` have no slot pointer: their slot is the dynamic value
  field, and `slot_va` / `slot_section` are null when that field is outside
  every load segment.
- Names are exact untrusted file text marked `observed-untrusted`. A target is
  named only by a defined symbol whose value equals it, or by the import name
  of an unresolved symbolic relocation or chained bind. An unreadable name
  (missing string table or offset outside it) is reported as no name and makes
  the report `incomplete`.
- Bounds: 64 MiB default file budget (512 MiB maximum); 65536 slots in total;
  65536 symbols across all ELF symbol tables; 65536 symbols across all
  Mach-O `LC_SYMTAB` commands; 1048576 section relocation records across all
  relocation sections; 1024-byte names. Reaching a bound makes the report
  `incomplete` with a limitation.
- Legacy Mach-O bind lookup permits at most 4096 candidate runs per query
  and twice the file byte count across image queries. Exhaustion leaves
  affected pointers unresolved; stream parsing and slot batches yield.
- Limitations are bounded: at most 24 distinct image observations, repeated
  per-row reasons reported once with a count, and at most 40 lines in total.
- Section lookups for slot and target addresses use an index built once per
  image, so their cost does not grow with headers times slots.
- Paging uses `offset` / `limit` (default 64, maximum 4096) over a stable
  ordered index. `coverage.examined_entries` counts every slot read, including
  omitted sentinels; `total_entries` is set only when the inventory is complete.
- Malformed headers, multiple `PT_DYNAMIC` segments and truncated dynamic
  sections fail without partial success. Cancellation is honored during slot
  collection, the section relocation walk and the dynamic relocation walk,
  which yields to other work at the shared reader's step boundaries.

## Acceptance

Parser tests cover ELF64 PIE (RELA, RELR, imports, `DT_INIT` / `DT_FINI`),
ELF32 REL in-place addends, `ET_REL` section relocations and sentinels,
unsupported relocation machines, slot, symbol and relocation budgets,
over-long names, tallied repeated observations, a near-maximal section table
with a full slot budget, cancellation in the relocation walks, skipped section
relocation tables, partly overwritten slots, `COPY` and TLS descriptor extents,
section `COPY` records sized by their symbol, section records that write
memory without file bytes, retained link-time
relocations, unreadable names, Mach-O chained fixups, `LC_DYLD_INFO` rebases, 32-bit images
with undecoded binds, `MH_OBJECT` section relocations, `__init_offsets`, the
shared and repeated `LC_SYMTAB` budget, and universal slices. CLI acceptance, filesystem boundary
and MCP boundary tests exercise the public workflows and Evidence output.

## Out of scope

Executing the image or proving that a listed address runs; runtime ordering
(file order is reported); disassembling initializer bodies; PE/COFF TLS
callbacks; Android packed relocations and machines other than x86-64, i386,
AArch64 and 32-bit ARM for relocation decoding; Mach-O fixup decoding for
images other than little-endian 64-bit arm64 and x86-64, and legacy
`LC_DYSYMTAB` external relocations.
