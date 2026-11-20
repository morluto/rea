# ELF dynamic dependencies

## Problem and outcome

An agent looking at a Linux program often needs to know what it loads before
it runs: the libraries it names, the paths it searches, its interpreter and the
GNU symbol versions it requires. Today that means `ldd`, which invokes the
dynamic loader, or `readelf`, which is not always installed and is not
Evidence.

This feature adds `inspect_elf_dependencies` and `inspect-elf-dependencies`.
They read the load-time dynamic-dependency inventory of one selected local
ELF32 or ELF64 `ET_EXEC` or `ET_DYN` image, without executing it, invoking the
dynamic loader or opening a disassembler.

[ELF dynamic dependencies](../../../elf-dependencies.md) describes the current
behavior and limitations. This directory is the feature specification,
implementation plan and task list. The guide does not replace these files.

## Requirements

1. `needed[]` lists every `DT_NEEDED` string in dynamic-table order, keeping
   duplicates. `DT_SONAME`, `DT_RPATH` and `DT_RUNPATH` are reported as
   written, with `:`-split entries that keep empties and `$ORIGIN`, `$LIB` and
   `$PLATFORM` tokens unexpanded, including `${...}` forms.
2. `DT_FLAGS` and `DT_FLAGS_1` decode into named `DF_*` and `DF_1_*` bits;
   unrecognized bits stay numeric. `PT_INTERP` is reported when present.
3. `version_requirements` walks `.gnu.version_r` / `DT_VERNEED` with each
   needed file's version names, hashes, weak flags and indices.
   `version_definitions` summarizes `.gnu.version_d` and `VER_FLG_BASE`.
4. `derived_version_maxima` takes the highest `NAME_x.y` requirement per
   namespace and is labelled `evidence_kind: "derived"`. Names outside that
   pattern stay out of the derived set, and maxima do not establish ABI
   compatibility.
5. `imports[]` lists undefined `.dynsym` symbols. With `.gnu.version`, each
   keeps its version index, hidden bit and a resolved `library@version` when a
   matching verneed record exists. Indices 0 and 1 are `unversioned`; a
   missing record is `unknown` and an issue.
6. `DT_*` entries are the load-time facts. A section header is used for a
   table only when it agrees with the `DT_*` address, file bytes, size and
   entry width; a disagreeing section is an issue and the `DT_*` declaration
   is used. Without section headers, tables are located from `PT_DYNAMIC` and
   `DT_*` addresses through `PT_LOAD`.
7. A missing `PT_DYNAMIC` is an observed empty inventory. A table that cannot
   be located, an unreadable string, an unterminated `PT_INTERP`, a hash-table
   symbol count past the located `.dynsym`, or a GNU version chain whose links
   and count disagree make coverage `partial` with issues. Complete coverage
   never retains issues.
8. Budgets bound the file size (64 MiB default, 512 MiB maximum), `DT_NEEDED`
   entries, GNU version records and undefined dynamic symbols, and each string
   scan to 65536 bytes. Decoded strings share one scan and retained-text budget
   fixed by the admitted image length. Exceeding a named budget fails with no
   partial success. Cyclic version chains, duplicate unique dynamic tags,
   malformed headers and unsupported extended numbering return no complete
   inventory.
9. `detail: "summary"` retains the complete Evidence and returns identity,
   counts and coverage. `inspect_analysis_view` with `kind:
   "elf-dependencies"` pages `needed`, `versions`, `definitions`, `maxima`,
   `imports` and `issues`. CLI summary requires `--evidence_output`.
10. Library, symbol and version names are target-derived and untrusted. MCP
    requires an absolute path; the CLI resolves relative paths against the
    caller's working directory.

## Acceptance

- Parser unit tests cover both widths and endiannesses, duplicate needed
  names, search-path tokens, flag decoding, verneed and verdef walks, import
  version joins, stripped section headers, disagreeing sections, budgets and
  partial coverage.
- Domain and service tests validate the report shape and the derived maxima.
- View tests and application acceptance tests cover summary delivery and the
  `inspect_analysis_view` collections.
- CLI acceptance, filesystem boundary and MCP boundary tests exercise the
  public contract.

## Non-goals

- Resolving `DT_NEEDED` names or expanding search-path tokens against the
  host filesystem.
- Invoking the dynamic loader or `ldd`, or executing the image.
- Relocatable objects and core dumps, which `inspect_kernel_module` and
  `inspect_recorded_crash` cover.
