# ELF and Mach-O initializer functions

`inspect_native_initializers` / `inspect-native-initializers` lists the
functions that one local ELF or Mach-O image declares to run before `main` and
at exit. It reads the file without executing it and does not need a
disassembler provider.

```bash
rea inspect-native-initializers /absolute/path/to/program --json
rea inspect-native-initializers ./Universal.app/Contents/MacOS/App --architecture arm64 --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path:

```json
{
  "name": "inspect_native_initializers",
  "arguments": { "path": "/artifacts/program", "offset": 0, "limit": 64 }
}
```

A universal Mach-O requires `architecture` to select one slice. ELF files and
thin Mach-O files do not take it.

## Sources

ELF entries are listed in this order:

| Kind            | Source                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| `preinit_array` | `DT_PREINIT_ARRAY` / `DT_PREINIT_ARRAYSZ`, else `.preinit_array`                      |
| `init`          | `DT_INIT`                                                                             |
| `init_array`    | `DT_INIT_ARRAY` / `DT_INIT_ARRAYSZ`, else `SHT_INIT_ARRAY` or `.init_array*` sections |
| `ctors`         | legacy `.ctors` and `.ctors.*` sections                                               |
| `fini`          | `DT_FINI`                                                                             |
| `fini_array`    | `DT_FINI_ARRAY` / `DT_FINI_ARRAYSZ`, else `SHT_FINI_ARRAY` or `.fini_array*` sections |
| `dtors`         | legacy `.dtors` and `.dtors.*` sections                                               |

Section fallback applies when the dynamic tag is absent, as in static
executables and relocatable objects. Mach-O entries come from sections typed
`S_MOD_INIT_FUNC_POINTERS` (`mod_init`), `S_INIT_FUNC_OFFSETS`
(`init_offsets`) and `S_MOD_TERM_FUNC_POINTERS` (`mod_term`).

## Entries

Each `entries[]` item reports:

- `slot_va`, `slot_file_offset`, `slot_bytes` and `slot_section`: where the
  pointer or offset is stored. For a universal Mach-O, file offsets are
  relative to the whole file, not the slice. For `init` and `fini` the slot is
  the `DT_INIT` / `DT_FINI` value field in the dynamic section. When that field
  is outside every load segment, `slot_va` and `slot_section` are null and a
  limitation says so.
- `value_va`, `value_file_offset` and `section`: the resolved target address,
  its file offset and its containing section. These are null when the value
  was not established. A file offset is also null when load segments map the
  address ambiguously (overlapping segments with different file offsets, or
  file and zero-fill memory), and the report is then `incomplete`.
- `symbol`: a defined symbol whose value equals the target exactly, or the
  import name of an unresolved symbolic relocation or chained bind.
- `resolution`: how the value was obtained.

| Resolution          | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `raw`               | The stored word, used when no relocation or fixup covers it          |
| `relative_addend`   | An `R_*_RELATIVE` relocation addend (RELA, or the REL in-place word) |
| `relr`              | A `DT_RELR` packed relative relocation                               |
| `symbol_addend`     | A section relocation against a defined symbol plus its addend        |
| `chained_fixup`     | A Mach-O chained-fixup rebase target                                 |
| `dyld_info_rebase`  | A Mach-O `LC_DYLD_INFO` rebase opcode target                         |
| `offset_table`      | A 32-bit `__init_offsets` value added to the image base              |
| `unresolved_import` | A relocation or bind against an undefined symbol                     |
| `unresolved`        | A slot whose value this inspection cannot establish                  |

A bound import name over the 1024-byte name budget is reported as no name and
makes the report `incomplete` with a counted limitation.

Symbol and section names are untrusted file text and carry
`trust: "observed-untrusted"`.

For PIE executables and shared objects the array slots are usually zero on
disk. A slot is reported `unresolved`, never as its stored zero, when the
dynamic relocation tables use an encoding this inspection does not decode
(for example Android packed relocations or an unsupported machine). Relative
relocations are decoded for x86-64, i386, AArch64 and 32-bit ARM. A slot is
also `unresolved` when a dynamic relocation writes only part of it, starts
inside it, or writes it more than once with different values.

Section `REL` / `RELA` tables are applied to slots that no dynamic relocation
covers. When such a table is skipped for an unexpected entry size, cannot be
read, or lies past the record budget, every slot it could reach that has no
relocation found is `unresolved`, and a `.ctors` slot is not dropped as a
sentinel. A section record that writes only part of a slot, starts inside it,
or repeats it also leaves the slot `unresolved`. In a relocatable object a
table reaches only the section named by its `sh_info`. In a linked image, a relocation section without `SHF_ALLOC`
(such as one kept by `--emit-relocs`) was already applied by the static
linker, so the slot's stored word is used rather than applying the record
again.

An absolute relocation against an `STT_GNU_IFUNC` symbol is `unresolved`: the
symbol value is the resolver, and the loader stores whatever the resolver
returns.

On 32-bit ARM (ELF `EM_ARM` and Mach-O `CPU_TYPE_ARM`), bit 0 of a function
pointer selects Thumb state. `value_va` keeps the pointer as stored, while
`value_file_offset` and `section` describe the code address with that bit
cleared. A Mach-O symbol is matched at either address.

In a relocatable object (`ET_REL`) every section starts at address 0. Slot
and value addresses are offsets inside the named section, and a limitation
says so.

Mach-O pointer slots are decoded through chained fixups or `LC_DYLD_INFO`
opcodes for linked little-endian arm64 and x86-64 images. Other linked images,
including 32-bit ones, have no fixup decoder here: their stored word is used
only when the image declares no `LC_DYLD_INFO` bind stream, and a pointer slot
is `unresolved` otherwise. Legacy external relocations (`LC_DYSYMTAB`
`nextrel`) are not decoded, so they make an otherwise raw pointer slot
`unresolved` in any image. In an object file (`MH_OBJECT`), each section's own
relocation entries set the slot: a pointer-width `UNSIGNED` entry against a
defined symbol gives `symbol_addend`, one against an undefined symbol gives
`unresolved_import`, a section-ordinal entry keeps the stored address, and any
other entry leaves the slot `unresolved`. An `arm64_32` image that declares a
64-bit header is rejected as malformed, since its pointers are four bytes.

`.ctors` and `.dtors` values `0` and `-1` are list sentinels and are omitted.
`-1` means all ones at the image's pointer width: `0xffffffff` in ELF32 and
`0xffffffffffffffff` in ELF64. A 64-bit slot holding `0xffffffff` is listed.
A stored zero in an initializer array is listed, so the array length stays
visible.

## Paging and limits

`offset` and `limit` page the ordered list (default limit 64, maximum 4096).
`coverage.examined_entries` counts every slot read, including omitted
sentinels, and `total_entries` (the listed entries) is set when the inventory
is complete. At most 65536 slots are examined; beyond that, or when relocation
coverage is unknown, `status` and `coverage.status` are `incomplete`.

ELF symbol names come from at most 65536 symbols across all `SHT_SYMTAB` and
`SHT_DYNSYM` tables together, and section `REL` / `RELA` relocations from at
most 1048576 records across all relocation sections together. Mach-O symbol
names come from at most 65536 symbols across all `LC_SYMTAB` commands
together; a repeated `LC_SYMTAB` over the same ranges is ignored with a
limitation. Reaching any of these budgets makes the report `incomplete` with a
limitation.

A symbol name that cannot be read, because its string table is missing or its
offset lies outside the table, is reported as no name and makes the report
`incomplete` with a counted limitation. Name offset 0 is the empty name.

The dynamic relocation tables are read in steps that yield to other work and
observe cancellation, so a large `DT_RELR` table does not block the server.

`limitations` lists the standing limitations, then at most 24 distinct
observations from the image. Reasons a crafted table can repeat per row, such
as symbol names over the 1024-byte budget or relocation sections with an
unexpected entry size, are reported once with a count, and observations past
the 24-note budget are counted in one closing line. The list never exceeds 40
lines.

The selected file is limited to 64 MiB by default (`max_file_bytes`, 512 MiB
maximum). Malformed headers, multiple `PT_DYNAMIC` segments and truncated
dynamic sections fail without partial success.

This inspection does not prove that a listed address runs, and file order is
not the runtime order: `DT_FINI` is listed before `fini_array`, while the
dynamic linker runs `fini_array` first, and `.ctors` runs in reverse order. A
missing tag or section is observed absence of that declaration, not proof that
no code runs before `main`.

Legacy Mach-O bind lookup examines at most 4096 candidate runs per query and
at most twice the file byte count across the decoded image's queries. These
resource allowances bound sparse, overlapping run descriptions without expanding
them into per-address objects. Exhaustion leaves pointer applicability unresolved
and the report incomplete. Bind-stream parsing and initializer batches yield so
other requests and cancellation can run.
