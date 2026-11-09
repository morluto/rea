# ELF unwind function ranges

`inspect_elf_unwind_ranges` / `inspect-elf-unwind-ranges` reads `.eh_frame`
and `.eh_frame_hdr` from one selected local ELF32/ELF64 image and lists the
function ranges those tables name. It reads the file without executing it and
does not require a disassembler.

```bash
rea inspect-elf-unwind-ranges /absolute/path/to/program --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_elf_unwind_ranges",
  "arguments": { "path": "/artifacts/program" }
}
```

Pass `--offset` and `--limit` (MCP `offset` and `limit`) to page the ranges.
The default page starts at 0 and returns at most 256 ranges.

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte
length, plus ELF class, byte order, machine, and object type.

`eh_frame.status` is `present`, `absent`, `incomplete`, or `unknown`. A
present table names its source: `section` when section headers name
`.eh_frame`, or `program` when section headers are missing and
`PT_GNU_EH_FRAME` supplies the bytes. `location` is the file range that was
examined. A `.eh_frame` section that is `SHT_NOBITS` or lies outside the file
is `incomplete` with a null `location`. One that runs past the end of the
file is `incomplete`, `location` is clamped to its in-file bytes, and the
records in those bytes are still decoded. Only the first `.eh_frame` and
`.eh_frame_hdr` section is decoded, and only the first `PT_GNU_EH_FRAME`
program header. A duplicate section, or a duplicate `PT_GNU_EH_FRAME` when no
`.eh_frame_hdr` section supplies the header, keeps `coverage.status` at
`incomplete`.

`eh_frame_hdr` reports version, the three pointer encodings, the `.eh_frame`
pointer, the declared FDE count, and how many binary-search table entries
were decoded. A header section that is `SHT_NOBITS` or extends past the end of
the file is `incomplete` with a null `location` and is not decoded.
`coverage.eh_frame_hdr_agreement` is `agree` when the table has exactly one
row per decoded FDE, the sorted starts match including repeats, and each row
points at a distinct FDE with that start. It is `disagree` otherwise, and
`unavailable` when the header is absent, unknown, or incomplete. Disagreement
is a limitation. The decoded FDEs stay in the result. The search table is
read for at most `max_ranges` rows, and for no more rows than the header bytes
can hold. When the declared FDE count is larger than either bound, the header
is `incomplete`, `table_entries` counts only the rows read, the comparison is
`unavailable`, and a limitation names the cap. A declared count that does not fit
in 32 bits is not decoded: `fde_count` is null, the header is `incomplete`,
and the decoded FDEs stay in the result. A header whose FDE count encoding is
`DW_EH_PE_omit` (`0xff`), as GNU ld writes when it cannot build the search
table, is `present` with a null `fde_count`, no table rows, and comparison
`unavailable`; it does not make coverage incomplete. A header that declares
an FDE count but writes `DW_EH_PE_omit` as its table encoding is `present`
with that count, no table rows, and comparison `unavailable`, and also keeps
coverage complete. A non-zero FDE count under an indirect encoding is the
address of a slot that is not followed, so `fde_count` is null, the header is
`incomplete`, and the table is not read.

When section headers name both `.eh_frame_hdr` and `PT_GNU_EH_FRAME`, the
section is decoded. A limitation names the segment as ignored only when it
declares different bytes than the section. When no `.eh_frame_hdr` section is
named, the header is read from `PT_GNU_EH_FRAME` even if a `.eh_frame`
section is present.

A record whose length word is `0xffffffff` uses the 64-bit extended length
that follows it. In `.eh_frame` the CIE ID and CIE pointer after that length
stay 4 bytes wide.

`DW_EH_PE_datarel` fields in `.eh_frame_hdr` are relative to the header
address. In `.eh_frame` they are relative to the GOT: `DT_PLTGOT` when the
dynamic table names it, otherwise the `.got.plt` or `.got` section address.
A limitation names the base that was used. When no GOT base is declared,
those values are unresolved: the affected record is not reported and
`coverage.status` is `incomplete`.

`debug_frame.status` is `present`, `absent`, `incomplete`, or `unknown`. It
is `unknown` when the image has no section headers or unreadable section
names. It is `incomplete`, with a null `location` and `coverage.status` at
`incomplete`, when the section is `SHT_NOBITS` or its bytes are not all in
the file. The `.eh_frame` results stay in the report. This command does not
decode `.debug_frame`.

`cies` lists the CIEs that the returned page's ranges name, in index order,
so its length never exceeds the page size. Each `cie_index` in `ranges`
matches the `index` of one entry in `cies`. `coverage.total_cies` counts every
decoded CIE, including CIEs no FDE on this page uses. Each CIE reports
version 1 or 3, augmentation, code and data alignment,
return-address register, pointer encoding, LSDA encoding, personality address
when the augmentation carries one, signal-frame and B-key flags, and the byte
length of the CFA program. CFA instructions are counted and not evaluated.
A CIE whose augmentation has a letter other than `z`, `L`, `P`, `R`, `S`, or
`B` is not decoded: the encodings of later letters cannot be trusted, so its
FDEs are not decoded either. A limitation counts those FDEs and coverage is
`incomplete`.

`ranges` is one page of FDEs. Each range has `start`, `end`, decimal `size`,
the containing `SHF_ALLOC` section, an exact symbol name when a symbol starts
at that address, the CIE index, LSDA, and personality. A function symbol is
preferred, then an `STT_GNU_IFUNC` symbol, then an untyped one. An IFUNC name
is the resolver that starts at that address, not the implementation it
selects at run time, and a limitation says so. On 32-bit ARM, bit 0 of a
function or IFUNC symbol value marks Thumb code and is cleared before the
match. Symbol names, section names,
and augmentation strings are target-derived and untrusted. Indirect EH
pointers are not dereferenced. An FDE whose initial location is indirect names
a pointer slot, not its function, so it is not reported as a range; a
limitation counts those FDEs and coverage is `incomplete`. An indirect
`eh_frame_ptr` does not locate `.eh_frame`, and the header is `incomplete`.
A search table with an indirect encoding is not read: the header is
`incomplete`, the comparison is `unavailable`, and the table does not bound a
header-located `.eh_frame`.

An encoded pointer whose stored value is zero is a null pointer, as libgcc
reads it: no PC-relative, text, data, or function base is added and an
indirect pointer is not followed. A resolved address, and an FDE `end`,
wraps at the ELF address width (32 or 64 bits), as libgcc's pointer
arithmetic does. A zero LSDA pointer is reported as a null
`lsda`, even when the CIE declares an LSDA encoding. An FDE whose initial
location is zero marks a function the linker discarded. It is not reported
as a range, `examined_records` still counts it, and a limitation counts how
many were skipped. In a relocatable object an unrelocated initial location
is also zero, so those FDEs are skipped too.

`page` reports `offset`, `limit`, `returned`, `total`, and `next_offset`.
`next_offset` is null when the page reaches the end of the decoded list.
`coverage` counts every decoded range, every decoded CIE, how many ranges
match a symbol, and how many do not. `examined_records` counts CIE and FDE records visited, including
records that could not be decoded.

A missing `.eh_frame` section and a missing `PT_GNU_EH_FRAME` segment are
observed absence of those declarations. That absence is not proof the image
has no functions. Program headers come from the shared ELF section
directory, which rejects an image whose program-header table cannot be read,
so a missing `PT_GNU_EH_FRAME` is always observed absence. When section
headers are missing too, section names are unknown, so a missing header is
`unknown` rather than `absent`.

A `.eh_frame` located only through the `.eh_frame_hdr` `eh_frame_ptr` has no
section size, so it is read up to the end of its `PT_LOAD` segment. Other
data, such as `.gcc_except_table`, can follow it there. When the search table
was decoded, the scan stops after the last FDE the table names, as libgcc's
`PT_GNU_EH_FRAME` lookup only binary-searches that table. Later bytes are not
decoded and a limitation says so. Without a usable table, the scan stops at
the first record that fails to decode, as libgcc's linear FDE search does,
and `coverage.status` is `incomplete`. A CIE with an unrecognized
augmentation letter, or an FDE that uses one, also stops that scan. Reaching the end of the segment with
no terminator also keeps coverage `incomplete`, because the table's extent is
then unknown.

Addresses map to file offsets through `SHF_ALLOC` sections, then `PT_LOAD`
segments. A section without `SHF_ALLOC`, such as `.comment` or `.debug_*`,
is not loaded, so its `sh_addr` is never used for translation and it is never
reported as the section containing a range. A record that ends past the table, or non-zero bytes after
the terminator, keeps `coverage.status` at `incomplete`. Relocatable objects
stay incomplete because relocations are not applied.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum).
`max_ranges` defaults to 8192 and caps at 65536. That ceiling applies
separately to CIE records and to FDEs. Exceeding either budget fails without
partial success. One page returns at most 4096 ranges. Symbol lookup stops
after 65536 entries across `.symtab` and `.dynsym` combined. Reaching that
cap keeps `coverage.status` at `incomplete`. Only symbols at decoded FDE
starts are kept, and a name is decoded only for a returned range. The names
on one page share a fixed 16 MiB text allowance; a page that exceeds it fails
with a resource error whose recovery is a smaller `limit`, because
`max_ranges` and `max_file_bytes` do not raise it.

Malformed ELF headers fail without partial success. This workflow does not
execute the image, evaluate CFA programs, or follow indirect pointers.
