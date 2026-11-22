# ELF dynamic dependencies

`inspect_elf_dependencies` / `inspect-elf-dependencies` answers which libraries
one selected local ELF32/ELF64 `ET_EXEC` or `ET_DYN` image declares it needs to
load, which search paths and interpreter it names, which GNU symbol versions it
requires, and which undefined `.dynsym` imports carry a `library@version` when
that join is known. It reads the file without executing it and does not invoke
the dynamic loader, `ldd`, or a disassembler.

```bash
rea inspect-elf-dependencies /absolute/path/to/program --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_elf_dependencies",
  "arguments": { "path": "/artifacts/program" }
}
```

Relocatable objects are not this inventory; use `inspect_kernel_module` for
Linux kernel modules. Core dumps are not this inventory; use
`inspect_recorded_crash`.

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte length.
`needed[]` lists every `DT_NEEDED` entry in dynamic-table order, including
duplicate names. An unreadable name stays null and retains its string-table
index. If that index has no backed string location, its diagnostic points to
the dynamic-table entry. `dynamic.soname` is the `DT_SONAME` string when that
tag is present. `dynamic.rpath` and `dynamic.runpath` keep the raw `DT_RPATH` /
`DT_RUNPATH` string, the `:`-split entries without dropping empties, and any
`$ORIGIN`, `$LIB`, or `$PLATFORM` tokens as written, including `${...}` forms.
Those tokens are not expanded against the host filesystem.

`dynamic.flags` and `dynamic.flags_1` decode `DT_FLAGS` and `DT_FLAGS_1` into
named bits (`BIND_NOW` / `NOW`, `ORIGIN`, `PIE`, `NODEFLIB`, and the other
documented `DF_*` / `DF_1_*` names). Unrecognized bits stay numeric.
`interpreter` is the `PT_INTERP` path when that program header is present.

`version_requirements` walks `.gnu.version_r` / `DT_VERNEED`: each needed file
and its required version names, hashes, weak flags, and version indices.
`derived_version_maxima` is a derived per-namespace maximum over GNU-style
`NAME_x.y` requirement strings (for example the highest `GLIBC_x.y`) and is
labelled `evidence_kind: "derived"`. Names that do not match that pattern stay
out of the derived set. `version_definitions` summarizes the image's own
`.gnu.version_d` names and the `VER_FLG_BASE` flag.

`imports[]` lists undefined `.dynsym` symbols. When `.gnu.version` is present,
each import keeps its version index, hidden bit, and a resolved
`library@version` when one matching verneed record supplies both strings.
Index 0 and 1 stay `unversioned`. An unreadable library or version name leaves
the corresponding import `unknown` while preserving the readable string.
Conflicting requirements for a single index also remain `unknown`.
For `DT_VERSYM`, the reader keeps the contiguous prefix of complete slots
that share one unambiguous file translation. It stops at the first slot that
cannot be admitted, even if later slots map independently. Later import
versions remain unexamined and coverage is `partial`.

A missing `PT_DYNAMIC` is an observed empty load-time dependency inventory. It
is not proof another overlay or container carried dynamic linking metadata.
`DT_*` entries are the load-time facts. A section header can locate a table
when its starting address, mapped file offset, and declared size or entry
width agree. A plain gap in load coverage can still allow recovery from the
section's file bytes. A different file translation or declared zero-fill in
the requested span prevents that recovery. A disagreeing section is reported
as an issue and the `DT_*` declaration is used. An admitted symbol-section
header can still name its string table when the symbol rows are unreadable. When section headers are
stripped, tables are located from `PT_DYNAMIC` and `DT_*` virtual addresses
through `PT_LOAD`. Coverage is `partial` when a table cannot be located or a
string cannot be read. Complete coverage never retains issues.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum). At most
1024 `DT_NEEDED` entries, 4096 GNU version records, and 65536 undefined
dynamic symbols are examined by default (65536 / 65536 / 262144 maximum).
Omitted budgets use these defaults during analysis and stay omitted in
Evidence parameters. Explicitly selecting a default value records that choice.
GNU hash decoding has a fixed allowance of 262144 bucket, bloom, or symbol
entries per table component; it yields between bounded steps so cancellation
can stop the walk. This work allowance has no runtime override.
Exceeding a named budget fails with no partial success. Decoded dynamic
strings share one scan and retained-text budget fixed by the admitted image
length, so names repeated by many rows cannot expand past the input size; this
budget has no runtime override. A failure after the file was read keeps its
path, SHA-256, and byte count as a partial observation. Cyclic `vn_next` /
`vna_next` chains, duplicate unique dynamic tags, malformed ELF headers, and
unsupported ELF extended numbering return no complete inventory.

Each dynamic string and `PT_INTERP` path is scanned for its terminator across at
most 65536 bytes. A scan-limit issue means the admitted extent continues beyond
the checked bytes. If the scan reaches the end of the extent without a
terminator, the issue identifies an unterminated string. Unreadable strings and
tables that cannot be located from section headers or `DT_*` tags yield partial
coverage with `issues`.
When the symbol count from `DT_HASH` or `DT_GNU_HASH` exceeds the located
`.dynsym` table, only the symbols inside that table are read and coverage is
partial. A GNU version chain whose links and declared count
disagree keeps the records read before the conflict, marks that table
`unreadable`, and reports partial coverage. `$ORIGIN`, `$LIB`, and `$PLATFORM` remain unexpanded.
Derived version maxima do not establish ABI compatibility.

Omitted or `complete` detail returns the inventory inline. `detail: "summary"`
retains the complete Evidence and returns identity, counts, and source
coverage. Query `inspect_analysis_view` with `kind: "elf-dependencies"` and
collection `needed`, `versions`, `definitions`, `maxima`, or `imports`, using
exact names (namespaces for `maxima`) or original indices, selected fields, and
matching-row pagination. Collection `issues` accepts original indices and
pagination only; its rows are returned whole and have no name filter. Summaries and pages report
version-definition and derived-maximum counts; those rows are paged through
their own collections. CLI summary
requires `--evidence_output`.

This workflow does not execute the image, invoke the dynamic loader, or resolve
`DT_NEEDED` paths against the host filesystem.
