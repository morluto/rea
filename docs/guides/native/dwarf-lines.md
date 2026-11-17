# DWARF line-number programs

`inspect_dwarf_lines` / `inspect-dwarf-lines` decodes DWARF 2 through 5
`.debug_line` line-number programs, directory and file tables (including
DWARF 5 MD5 digests), and line-matrix sequences offline from one explicit
local ELF, Mach-O, or PE image without launching a disassembler or external
tools, and optionally attributes virtual addresses (`addresses`) back to
`file:line:column`.

```bash
rea inspect-dwarf-lines /absolute/path/to/program --json
rea inspect-dwarf-lines /absolute/path/to/program --addresses 0x401130 --json
rea inspect-dwarf-lines /absolute/path/to/program --program-offset 0 --max-rows 0 --json
```

```json
{
  "name": "inspect_dwarf_lines",
  "arguments": {
    "path": "/artifacts/program",
    "addresses": ["0x401130"]
  }
}
```

The [feature specification](../../specs/native/dwarf-lines/spec.md),
[plan](../../specs/native/dwarf-lines/plan.md), and
[tasks](../../specs/native/dwarf-lines/tasks.md) record the requirements and
design boundaries.

## Decoding rules

- Reads ELF, PE, and thin Mach-O images directly; universal Mach-O images require
  `architecture` (which is rejected for every other container). A `.dSYM` bundle
  is not opened automatically—pass the DWARF binary inside the bundle.
- Locates `.debug_line`, `.debug_line_str`, `.debug_str`, and
  `.debug_str_offsets` across uncompressed, ELF `SHF_COMPRESSED` (zlib/zstd),
  legacy GNU `.zdebug_*`, and Mach-O `__zdebug_*` sections under the shared
  `256 MiB` decompressed section allowance.
- Supports both 32-bit and 64-bit DWARF initial lengths across DWARF versions
  2, 3, 4, and 5 (`directory_entry_format` and `file_name_entry_format`,
  including `DW_LNCT_path`, `DW_LNCT_directory_index`, `DW_LNCT_timestamp`,
  `DW_LNCT_size`, `DW_LNCT_MD5`, `DW_LNCT_LLVM_source`, and `DW_FORM_indirect`).
- Executes DWARF 2–5 extended, standard, and special opcodes including DWARF 4+
  `maximum_operations_per_instruction` (`op_index`) stepping, while skipping
  unrecognized standard opcodes by their declared `standard_opcode_lengths`
  arity and unrecognized extended opcodes by declared length.

## Virtual address resolution

When `addresses` is supplied (up to 64 distinct `0x...` values), every decoded
sequence `[row.address, next_row.address)` is indexed and queried in request
order:

- `resolved`: One or more contiguous `[span_start, span_end)` spans contain the
  queried virtual address (co-located location-view rows at the same PC are all
  returned). Sequences lacking `DW_LNE_end_sequence` only match their final row
  when `exact` is true.
- `not_found`: Every selected `.debug_line` program was walked completely and
  none covered the address.
- `unapplied_relocation`: An ELF `ET_REL` or Mach-O `MH_OBJECT` object carries
  unapplied relocations targeting `__DWARF,__debug_line` / `.debug_line` (such
  as `.rela.debug_line`), leaving address operands and DWARF 5 external string
  offsets at unlinked placeholders. Relocated DWARF 5 string references remain
  `unresolved`, `addresses_unresolved` is `true`, and `addresses` queries never
  treat `0x0` placeholders as resolved addresses.
- `incomplete`: Line-program coverage stopped early (for example at the
  decode step/header-entry/match budget, the 100,000-program walk cap, or a
  truncated/unreadable section) before proving the address absent.

## Delivery, paging, and budgets

- `max_file_bytes` defaults to `64 MiB` (maximum `512 MiB`).
- `max_programs` defaults to `256` (maximum `16,384`; `addresses` lookups
  continue scanning up to `100,000` programs past `max_programs`).
- `max_rows` defaults to `4,096` (maximum `65,536`). Pass `max_rows: 0` to keep
  program headers, directory/file tables, sequences, and `addresses` lookups
  with `complete` coverage while omitting inline row matrices.
- Shared decode work is capped at `2,097,152` steps, aggregate header tables at
  `262,144` entries across programs (`65,536` per table), header string
  retention at `16 MiB` (`64 KiB` per C-string), expanded file paths/labels at
  `16 MiB` characters, sequence summaries at `65,536`, per-sequence index rows
  at `262,144`, retained address matches at `65,536`, and program issues at `32`
  per program.
- Set `detail: "summary"` to retain the complete Evidence in the session (or via
  CLI `--evidence_output`) and query `inspect_analysis_view` with
  `kind: "dwarf-lines"` across collections `"programs"`, `"directories"`,
  `"files"`, `"rows"`, `"address_matches"`, and `"issues"`.

Target-derived directory names, file paths, and line numbers are untrusted
strings; external `.dwo`, `.gnu_debuglink`, and build-id files are not opened
automatically.
