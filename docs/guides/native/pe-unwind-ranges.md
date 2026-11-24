# PE x64 exception-directory function ranges

Use `inspect_pe_unwind_ranges` to read the x64 exception directory (`.pdata`)
of an explicit local PE32+ image. Each `RUNTIME_FUNCTION` entry is the
compiler's record of a function range that needs unwind data. No disassembler,
Windows host, or target execution is required.

```sh
rea inspect-pe-unwind-ranges /absolute/path/to/application.exe --limit 0 --json
rea inspect-pe-unwind-ranges /absolute/path/to/application.exe --kind chained --json
```

MCP accepts `{ "path": "/absolute/path/to/application.exe" }`. CLI paths may be
relative to the current directory; MCP paths must be absolute.

## What it reports

- `exception_directory` gives data directory 3's RVA, size, file offset and
  section. `status` is `present`, `absent`, or `unsupported_machine`. Only the
  x64 (`IMAGE_FILE_MACHINE_AMD64`) entry layout is decoded. ARM64 and other
  machines use other `.pdata` formats.
- Addresses are RVAs (`address_space: "rva"`). Add `image_base` to compare them
  with provider virtual addresses.
- `coverage` counts every entry whatever page you select: `primary_entries`,
  `chained_entries`, `unknown_entries`, `entries_with_issues`, and the
  directory's `trailing_bytes` after its last whole 12-byte entry.
- Each entry has its begin, end and unwind RVAs, the `UNWIND_INFO` version,
  flags (`ehandler`, `uhandler`, `chaininfo`) and code count, and its `kind`:
  - `primary` starts a function.
  - `chained` is a fragment whose unwind data continues another entry. This is
    either `UNW_FLAG_CHAININFO`, whose chained `RUNTIME_FUNCTION` follows the
    code array padded to an even count, or an unwind RVA with its low bit set
    (`RUNTIME_FUNCTION_INDIRECT`). `parent` is the named `RUNTIME_FUNCTION` and
    its table index, and `primary_index` is the entry the chain reaches. Hot and
    cold splitting produces these fragments, and they are not separate
    functions.
  - `unknown` means that the unwind information is not file-backed or declares
    an unknown version.
- `issues` flags `empty_range`, `unsorted`, `overlaps_previous`,
  `unwind_unmapped`, `unwind_version_unknown`, `unwind_codes_unmapped`
  (the declared code array leaves the file-backed bytes), `chain_parent_missing`,
  `chain_parent_mismatch` (an entry begins where the chain names but its end or
  unwind RVA differs) and `chain_cycle`. Flagged entries stay in the table and are not dropped.

Select entries with `kind` (`all`, `primary`, `chained`, `issues`) and page
them with `offset` and `limit`. `limit: 0` returns counts only.

## Reading the result

The primary entries are the compiler's non-leaf function starts. Leaf functions
that need no unwind data have no entry, and neither do most jump thunks, so a
missing entry does not prove that no function starts at an address. Unwind
codes, handlers and frame registers are counted, not evaluated.

To check a provider's function inventory, compare each procedure's address minus
`image_base` with the primary begin RVAs. Procedures that start at a chained
fragment, inside a primary range, or on padding outside every range are provider
findings that the table does not support.

## Failures

A directory that is not backed by file bytes, a zero RVA with a nonzero size,
or a file cut inside the table is refused as a malformed target, without
partial success. A table with more than 2,097,152 entries exceeds the fixed
decoding allowance. The input read budget is `max_file_bytes` (default 64 MiB,
at most 512 MiB).
