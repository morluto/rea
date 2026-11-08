# Native initializer and finalizer functions

## Problem and outcome

Analysts reviewing a native image need the functions it declares to run before
`main` and at exit, without executing it or opening a disassembler provider.
`inspect_native_initializers` / `inspect-native-initializers` lists the
initializer and finalizer slots of one local ELF or Mach-O image, with each
slot's location, resolved target and how that target was obtained. The
[user guide](../../../native-initializers.md) documents the result.

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
  word when relocation coverage is known. Mach-O uses chained-fixup rebases
  and `__init_offsets` image-base offsets. Anything else is `unresolved`, never
  a stored zero.
- Relocatable objects (`ET_REL`) report section-relative offsets and say so.
- `.ctors` / `.dtors` sentinels are 0 and all ones at the image's pointer width;
  they are omitted and counted in a limitation.
- `DT_INIT` / `DT_FINI` have no slot pointer: their slot is the dynamic value
  field, and `slot_va` / `slot_section` are null when that field is outside
  every load segment.
- Names are exact untrusted file text marked `observed-untrusted`. A target is
  named only by a defined symbol whose value equals it, or by the import name
  of an unresolved symbolic relocation or chained bind.
- Bounds: 64 MiB default file budget (512 MiB maximum); 65536 slots in total;
  65536 symbols across all ELF symbol tables; 65536 symbols across all
  Mach-O `LC_SYMTAB` commands; 1048576 section relocation records across all
  relocation sections; 1024-byte names. Reaching a bound makes the report
  `incomplete` with a limitation.
- Limitations are bounded: at most 24 distinct image observations, repeated
  per-row reasons reported once with a count, and at most 40 lines in total.
- Section lookups for slot and target addresses use an index built once per
  image, so their cost does not grow with headers times slots.
- Paging uses `offset` / `limit` (default 64, maximum 4096) over a stable
  ordered index. `coverage.examined_entries` counts every slot read, including
  omitted sentinels; `total_entries` is set only when the inventory is complete.
- Malformed headers, multiple `PT_DYNAMIC` segments and truncated dynamic
  sections fail without partial success. Cancellation is honored during slot
  collection and the section relocation walk.

## Acceptance

Parser tests cover ELF64 PIE (RELA, RELR, imports, `DT_INIT` / `DT_FINI`),
ELF32 REL in-place addends, `ET_REL` section relocations and sentinels,
unsupported relocation machines, slot, symbol and relocation budgets,
over-long names, tallied repeated observations, a near-maximal section table
with a full slot budget, cancellation in the relocation walk, Mach-O chained
fixups, `__init_offsets`, the shared and repeated `LC_SYMTAB` budget, and
universal slices. CLI acceptance, filesystem boundary
and MCP boundary tests exercise the public workflows and Evidence output.

## Out of scope

Executing the image or proving that a listed address runs; runtime ordering
(file order is reported); disassembling initializer bodies; PE/COFF TLS
callbacks; Android packed relocations and machines other than x86-64, i386,
AArch64 and 32-bit ARM for relocation decoding.
