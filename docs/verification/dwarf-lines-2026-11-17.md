# DWARF line-number program verification - 2026-11-17

Host: `Linux x86_64`, Node `v24.22.1`. Command: `npm run verify:dwarf-lines`
(`node scripts/verify-dwarf-lines.mjs`). No target binary was executed.

Compilers and dumper:

- `Ubuntu clang version 21.1.8 (6ubuntu1)`
- `gcc (Ubuntu 15.2.0-16ubuntu1) 15.2.0`
- `GNU readelf (GNU Binutils for Ubuntu) 2.46` (`--debug-dump=rawline` and
  `--debug-dump=decodedline`)

The fixture compiles a multi-file C program (`include/helper.h`, `alpha.c`,
`beta.c`) across DWARF versions 2, 3, 4, and 5, 64-bit DWARF (`-gdwarf64`),
optimization (`-O2`), and ELF `.debug_line` compression (`zlib` and `zstd`).
Each binary was inspected with `DwarfLinesService.inspect`, querying virtual
addresses obtained from `nm -n` (`alpha` and `alpha + 4`), and compared against
`readelf` for program offsets, payload lengths, DWARF versions, compression
formats, and every decoded source row for `alpha.c`, `beta.c`, and `helper.h`.

| Variant                    | Programs | Rows | `.debug_line` compression | Sample `alpha` resolution                                      |
| -------------------------- | -------- | ---- | ------------------------- | -------------------------------------------------------------- |
| `clang-dwarf2`             | 2        | 25   | none                      | `alpha.c:3`                                                    |
| `clang-dwarf3`             | 2        | 25   | none                      | `alpha.c:3`                                                    |
| `clang-dwarf4`             | 2        | 25   | none                      | `alpha.c:3`                                                    |
| `clang-dwarf5`             | 2        | 25   | none                      | `alpha.c:3`                                                    |
| `clang-dwarf5-O2`          | 2        | 11   | none                      | `helper.h:3`                                                   |
| `clang-dwarf64`            | 2        | 25   | none                      | `alpha.c:3`                                                    |
| `clang-zlib`               | 2        | 25   | zlib                      | `alpha.c:3`                                                    |
| `clang-zstd`               | 2        | 25   | zstd                      | `alpha.c:3`                                                    |
| `gcc-dwarf4`               | 2        | 24   | none                      | `alpha.c:3`, `alpha.c:3`                                       |
| `gcc-dwarf5`               | 2        | 24   | none                      | `alpha.c:3`, `alpha.c:3`                                       |
| `gcc-zstd`                 | 2        | 15   | zstd                      | `alpha.c:3`                                                    |
| `clang-et-rel` (`alpha.o`) | 1        | 17   | none                      | `addresses_unresolved: true`, `status: "unapplied_relocation"` |

Mach-O and PE containers, big-endian byte orders, VLIW `op_index` stepping,
truncated/malformed recovery, `max_rows` / `max_programs` ceilings, and
multiple `.debug_str_offsets` tables are verified by synthetic fixtures in the
unit and provider test suites rather than cross-compiled on this host.
