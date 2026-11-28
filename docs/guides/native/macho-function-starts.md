# Mach-O function starts and data in code

Use `inspect_macho_function_starts` to read `LC_FUNCTION_STARTS` and
`LC_DATA_IN_CODE` from one thin Mach-O, or from one slice of a universal file.
`LC_FUNCTION_STARTS` is the linker's ULEB128 delta list of function starts.
Images that carry `LC_DATA_IN_CODE` mark jump tables and literal data inside
`__TEXT`. The reader does not disassemble and does not execute the image.

```sh
rea inspect-macho-function-starts /absolute/path/to/program --limit 0 --json
rea inspect-macho-function-starts /absolute/path/to/program --architecture arm64 --kind starts --json
```

MCP accepts `{ "path": "/absolute/path/to/program" }`. A universal file also
needs `architecture`. CLI paths may be relative to the current directory; MCP
paths must be absolute.

## What it reports

- `function_starts` and `data_in_code` give each command's `dataoff`,
  `datasize`, container `file_offset`, and whether that range sits in
  `__LINKEDIT`. `status` is `present` or `absent`. A relocatable object
  (`MH_OBJECT`) has no `__LINKEDIT` segment, so its tables report
  `in_linkedit: false` without counting as misplaced.
- Start addresses are absolute VM addresses. The first delta is added to the
  `vmaddr` of the first declared `__TEXT` segment, which need not have file
  bytes, as `llvm-objdump --function-starts` does. A zero delta ends the list.
  Zero bytes after that terminator are padding. A sum past the image's 32- or
  64-bit address space is a wrapped start. dyld adds the deltas to the
  `mach_header` address instead. The two agree when `__TEXT` maps file offset 0. When it doesn't, `coverage.text_not_at_header` is 1 and coverage is
  `partial`, because the base is disputed.
- On 32-bit ARM, ld64 sets bit 0 of a Thumb start and takes the next delta
  from that tagged value. `vmaddr` clears that bit, as LLDB does, and `thumb`
  records whether it was set. Other architectures omit `thumb`.
- Each start names the section that contains it, such as `__text`.
- Each data-in-code entry has its `data_in_code_entry` `offset`, its VM
  address, `length`, and `kind`. ld64 writes the offset as the entry's address
  minus the `mach_header` address, and dyld documents it as a delta from the
  `mach_header`, so the VM address is that header address plus the offset. A
  relocatable object (`MH_OBJECT`) does not map its header, so its offset is
  the address itself. An entry whose header address is unknown or ambiguous,
  or whose address is outside every segment, has no VM address and counts as
  unmapped. The kinds are:
  - `DICE_KIND_DATA`
  - `JUMP_TABLE8`
  - `JUMP_TABLE16`
  - `JUMP_TABLE32`
  - `ABS_JUMP_TABLE32`
  - Any other kind stays the numeric `uint16`.
- `owner` is the greatest decoded start at or before that VM address, with
  that start's index.
- `coverage` counts every start and every complete 8-byte data entry. It also
  counts duplicate commands, commands whose `cmdsize` is not 16, tables outside
  `__LINKEDIT`, commands that extend past the file, truncated or overflowing
  ULEB128, wrapped addresses, addresses outside every executable segment, a
  missing `__TEXT` anchor, a `mach_header` not mapped at the `__TEXT` vmaddr,
  a list that ends without its zero terminator, nonzero bytes after the
  terminator, a data tail
  shorter than 8 bytes, entries that leave their section, offsets that are not
  strictly increasing, offsets outside every segment, and zero lengths. Any of
  those counters makes `coverage.status` `partial`.
- `page` records `kind` (`all`, `starts`, or `data`), `offset`, `limit`, and
  the next offset of each selected table. The same offset and limit apply to
  each selected table. `limit: 0` returns counts only. Every entry is checked
  and counted, but only the returned page is built, so a small page of a large
  table stays small in memory.
- The Evidence file ranges of the two tables stay inside the selected slice.
  A table declared past the slice's end keeps its declared `dataoff` and
  `file_offset`, but contributes no range in another slice's bytes.

## Reading the result

The starts are the addresses the linker recorded. A stripped image can still
carry the list. A missing command is `absent`, and the standing limitations
say what that absence leaves unknown. Compare a provider procedure address
with `starts[].vmaddr`. A data-in-code entry names the start that owns its
address, so a jump table or literal pool inside a function stays attached to
that start.

When a command is declared more than once, the first one is decoded. Decoding
stops at the first wrapped or out-of-text start, and that address stays in
the list.

## Failures

A file that is not Mach-O, such as an ELF or PE image, is a target failure
of kind `unrecognized`: this operation reads only Mach-O. A Mach-O whose
header or load commands are broken, or a universal slice that cannot be read,
is a target failure of kind `malformed` or `truncated`. `architecture` on a thin image is refused. A universal file
without `architecture` is refused.

`max_entries` (default 2,097,152, at most 16,777,216; CLI `--max-entries`)
bounds decoded starts plus complete data-in-code entries, and bounds the
decoding work as well as the result. A data table larger than the allowance
is refused from its byte count before any entry is examined, and the start
walk stops once the combined count would pass it. When the image has no
function starts to decode, the data count is the whole total and the refusal
reports it as `required_value`. Otherwise decoding stopped before the total
was measured, so `details.limit` omits `required_value`. The call returns no partial report.

The default [read allowance](../../reference/limits-and-recovery.md#static-reader-read-allowance)
is 64 MiB (`max_file_bytes`, floor 64 bytes, ceiling 512 MiB). The identity
pass stops at 4 GiB minus one byte, because `dataoff` and FAT32 slice offsets
are 32-bit. `max_file_bytes` does not raise that ceiling.
`max_structure_bytes` bounds the load-command table read.
