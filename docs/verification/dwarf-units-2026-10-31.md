# DWARF compile-unit verification - 2026-10-31

Host: macOS arm64 (`uname -sm` printed `Darwin arm64`), Node v24.22.1
(`node -v`). Command: `npm run verify:dwarf-units`
(`node scripts/verify-dwarf-units.mjs`). Node printed
`ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time`
while loading verifier source. `llvm-dwarfdump` was not on `PATH`.

Compiler: Apple clang 21.0.0 (clang-2100.1.1.101) at `/usr/bin/clang`.
`xcrun --find clang` printed
`/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang`,
which is the `InstalledDir` from `/usr/bin/clang --version`. Dumper: Homebrew
LLVM 23.1.4 `llvm-dwarfdump --debug-info` at
`/opt/homebrew/opt/llvm/bin/llvm-dwarfdump`. ELF objects were linked with
`/opt/homebrew/bin/ld.lld` (Homebrew LLD 23.1.4, `ld.lld -e alpha`) before
the comparison. PE objects were linked with the same binary
(`ld.lld -m i386pep --entry alpha --subsystem console`). No target was
executed.

The fixture is two C files, `alpha.c` and `beta.c`. Each checked variant
compared every unit's version, name, comp_dir, producer, and dwo_name with
`llvm-dwarfdump`. A disagreement fails the script. `.dwo` files were moved
aside before the dump so neither side followed split DWARF.

Mach-O rows are the two object files; this script does not link them. ELF
rows are the one image from `ld.lld`. PE rows are the one image from `ld.lld`.

| Variant                | Files            | Units | Version | Offset size | `dwo_name` values | `.debug_info` compression |
| ---------------------- | ---------------- | ----- | ------- | ----------- | ----------------- | ------------------------- |
| dwarf4                 | 2 Mach-O objects | 2     | 4       | 4           | 0                 | none                      |
| dwarf5                 | 2 Mach-O objects | 2     | 5       | 4           | 0                 | none                      |
| zlib                   | 2 Mach-O objects | 2     | 5       | 4           | 0                 | none                      |
| zstd                   | 2 Mach-O objects | 2     | 5       | 4           | 0                 | none                      |
| split                  | 2 Mach-O objects | 2     | 5       | 4           | 0                 | none                      |
| elf-dwarf2             | 1 ELF executable | 2     | 2       | 4           | 0                 | none                      |
| elf-dwarf3             | 1 ELF executable | 2     | 3       | 4           | 0                 | none                      |
| elf-dwarf4             | 1 ELF executable | 2     | 4       | 4           | 0                 | none                      |
| elf-dwarf5             | 1 ELF executable | 2     | 5       | 4           | 0                 | none                      |
| elf-dwarf64            | 1 ELF executable | 2     | 5       | 8           | 0                 | none                      |
| elf-zlib               | 1 ELF executable | 2     | 5       | 4           | 0                 | zlib                      |
| elf-zstd               | 1 ELF executable | 2     | 5       | 4           | 0                 | zstd                      |
| elf-split              | 1 ELF executable | 2     | 5       | 4           | 2                 | none                      |
| elf-dwarf4-split       | 1 ELF executable | 2     | 4       | 4           | 2                 | none                      |
| elf-big-endian-aarch64 | 1 ELF executable | 2     | 4       | 4           | 0                 | none                      |
| pe-dwarf4              | 1 PE executable  | 2     | 4       | 4           | 0                 | none                      |
| pe-dwarf5              | 1 PE executable  | 2     | 5       | 4           | 0                 | none                      |

The script also fails when a variant does not exercise what it names: its
expected DWARF version, 8-byte offsets for `elf-dwarf64`, the expected
`.debug_info` compression, or a `dwo_name` on every unit for `elf-split` and
`elf-dwarf4-split`. `elf-dwarf4-split` carries `DW_AT_GNU_dwo_name`; `elf-split`
carries the DWARF 5 `DW_AT_dwo_name`.

`elf-zlib` and `elf-zstd` were linked with `--compress-debug-sections=zlib`
and `--compress-debug-sections=zstd`. Apple clang accepted `-gz=zlib` and
`-gz=zstd` on the Mach-O rows and on the ELF objects, and those objects
stayed uncompressed. The compressed rows are the LLD link. Apple clang also
accepted `-gsplit-dwarf` on the Mach-O `split` row, which has no `dwo_name`
values.

The script then checks three files whose facts it does not take from the
dumper. Each compares `inspect_dwarf_units` with a fixed expectation.

| File                     | Source                          | Units | Coverage | Checked result                                                                                            |
| ------------------------ | ------------------------------- | ----- | -------- | --------------------------------------------------------------------------------------------------------- |
| `elf-relocatable-object` | one `clang -c` ELF object       | 1     | complete | `abbrev_offset` 0 with `language` present; `name` and `stmt_list` unresolved                              |
| `elf-relocatable-merged` | `ld.lld -r` of two ELF objects  | 2     | complete | every `abbrev_offset` null, `name` unknown, and `unapplied_relocation` issued; unit count from the dumper |
| `elf-dwo-object`         | the `.dwo` from `-gsplit-dwarf` | 0     | partial  | reason `Split DWARF section .debug_info.dwo is not read`                                                  |

Skipped:

- `elf-big-endian` (`-target powerpc-unknown-linux-gnu`): Apple clang reports
  `error: unable to create target: 'No available targets are compatible with triple "powerpc-unknown-linux-gnu"'`.
  Big-endian coverage on this host is the checked `aarch64_be-unknown-linux-gnu`
  row.

Truncated units, unknown forms, abbreviation offsets, abbreviation tables past
the per-table budget, Mach-O `__zdebug_*` sections, undecodable `.debug_info`,
and the decompressed-size allowance are covered by the synthetic fixtures, not
by this compiler run. No GCC-produced object was compared, and no `.dSYM` bundle
or linked Mach-O image was read.
