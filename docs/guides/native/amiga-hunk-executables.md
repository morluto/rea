# Amiga Hunk executables

`inspect-artifact` and `extract-artifact` recognize an AmigaOS Hunk file by
the big-endian longword `0x000003F3` (a load file) or `0x000003E7` (an object
file), regardless of filename. The reader works on local bytes only: it does
not run the program, apply relocations, or change the file. The container
does not name a CPU. Motorola 68000 is the usual machine, and that fact has
to come from outside the file.

## Load files

A load file starts with `HUNK_HEADER`. The header lists resident library
names, a hunk table size, the first and last hunk numbers, and one size
longword per hunk. Bits 31-30 of a size longword select memory:

| Bits | Memory   |
| ---- | -------- |
| `00` | any      |
| `01` | chip     |
| `10` | fast     |
| `11` | extended |

Extended memory consumes the next longword as raw memory flags. Bits 29-0
are the size in longwords.

Each hunk is then a block: `HUNK_CODE` (`0x3E9`), `HUNK_DATA` (`0x3EA`) or
`HUNK_BSS` (`0x3EB`), followed by relocation tables (`HUNK_RELOC32`,
`HUNK_RELOC32SHORT`, `HUNK_DREL32`), optional `HUNK_SYMBOL` and `HUNK_DEBUG`
blocks, and `HUNK_END`. Bits 29-31 on a block type (advisory, chip, fast) are
masked, so the type is still recognized. Load-file memory comes from the
header size word, not from those bits. In a load file, `HUNK_DREL32`
(`0x3F7`) uses the same 16-bit count, target and offset words as
`HUNK_RELOC32SHORT`, padded to a longword. The kind stays `drel32`.
`HUNK_RELOC32` uses 32-bit words.

The root `format_metadata` (`kind: "amiga-hunk"`, `file_kind: "load"`)
reports resident libraries, the table size, the first and last hunk, and one
record per hunk:

| Field                         | Meaning                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `index`                       | Hunk number from the header (`first` plus the table index)       |
| `type`                        | `code`, `data` or `bss`, or null when the body was not reached   |
| `memory`                      | `any`, `chip`, `fast` or `extended`                              |
| `extended_flags`              | Raw flags longword when memory is extended; otherwise null       |
| `declared_longwords`          | Size the header declares                                         |
| `stored_longwords`            | Longword count in the hunk block, including BSS                  |
| `stored_bytes`, `file_offset` | Stored byte range in the file; null for BSS                      |
| `name`                        | The `HUNK_NAME` before the hunk, or null                         |
| `relocations`                 | Counts per kind and target hunk. Offsets are not kept            |
| `symbols`                     | Names and offsets. A name ends at the first NUL                  |
| `debug`, `debug_longwords`    | Whether a debug hunk is present, and how many longwords it holds |

## Entries

`hunk-<n>-code.bin` and `hunk-<n>-data.bin` are the stored bytes. `n` is the
header hunk number. `source_location` is that range. Entry metadata
(`kind: "amiga-hunk-entry"`) records the hunk number, role, memory, and the
declared and stored sizes.

A BSS hunk has no stored bytes and no entry. Its size stays in the hunk
record. A header may allocate more longwords than the block stores; the
loader zero-fills the tail, so that is not a limitation. A block that stores
more than its header allocates is a `size-mismatch` limitation, and the entry
still contains the stored bytes when they fit in the file.

## Object files

An object file starts with `HUNK_UNIT`. The reader lists each unit's name and
the hunks inside it. Hunk numbers restart at 0 in each unit. Memory flags
come from the code, data or BSS block type. When both memory bits are set,
the next longword is the raw memory flags. An object file's `HUNK_DREL32`
uses 32-bit words. Each hunk record carries `unit`, the index of the unit it
belongs to (`null` in a load file). Object files are listed only: they
produce no entries, and neither `hunk-<n>-*.bin` nor a per-unit file is
extracted. A walk that stops inside a unit, for example at `HUNK_EXT`, keeps
the units and hunks read so far in metadata.

## Open a code hunk as m68k

Relocations are reported and not applied. Hunks stay separate. Extract one
code hunk, then open that file as a raw big-endian m68k image. File offset 0
of the extracted hunk is mapped at `entry_point`. Choose an even address.

```sh
rea inspect-artifact ./program.hunk --json
rea extract-artifact ./program.hunk --json
rea function /absolute/path/to/hunk-0-code.bin 0x1000 --target-format raw-binary --architecture m68k --entry-point 0x1000 --provider ghidra --json
```

`extract-artifact` writes `hunk-<n>-code.bin` into the directory it reports.
The `function` command opens that file, not the Hunk container. The raw lane
does not read a Hunk header or a vector table. Windows Ghidra P0 admits raw
images only for `6502`.

## Limits

Amiga Hunk inventory stops at fixed allowances: 64 MiB for the file, 1024
hunks (and 1024 object units), 65536 relocations in one hunk, 65536 relocation records (distinct kind and target pairs) across the file (a separate relocation-record allowance), and 65536 bytes of resident-library,
hunk, symbol and object-file unit names. A larger table is a fixed ceiling, not a partial
inventory. This release has no runtime override. `artifact_limits.expanded_bytes`
does not apply: each entry is a stored range of the file.

## Limitations

Coverage is `complete` only when the walk finishes with no limitations.
Anything else leaves coverage `unknown` and keeps the facts that still hold:

- a truncated structure;
- an unknown block type (the walk stops, and the detail names the offset);
- a hunk without `HUNK_END`;
- a block that stores more longwords than the header allocates
  (`size-mismatch`; a smaller stored size is the loader's zero-filled tail
  and is not a limitation);
- a relocation whose target hunk is outside the header range, or whose
  offset does not fit in the hunk;
- trailing bytes after the last hunk;
- a header problem (first hunk after last, a block past the listed hunks, or
  the file ending before every listed hunk);
- a relocation, symbol, debug or end block with no open hunk.

## What this does not do

The reader does not link hunks into one image, run the program, name a CPU,
decode `HUNK_EXT` external references, or treat a debug hunk as source.
