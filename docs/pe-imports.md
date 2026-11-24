# PE import and delay-load tables

`inspect_pe_imports` / `inspect-pe-imports` answers whether one selected local
PE32/PE32+ image declares an `IMAGE_DIRECTORY_ENTRY_IMPORT` table, which DLLs
and functions that table names, which delay-load descriptors are present, and
the pefile-compatible import hash of the standard import table. It reads the
file without executing it and does not require a Windows SDK or disassembler.

```bash
rea inspect-pe-imports /absolute/path/to/application.exe --json
```

The CLI resolves relative paths against the caller's working directory. MCP
and the advertised input schema require an absolute filesystem path and
preserve that exact selection:

```json
{
  "name": "inspect_pe_imports",
  "arguments": { "path": "/artifacts/application.exe" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, byte length and
the optional-header `image_base`. Each function row gives its import address
table slot as `iat_rva` and as `iat_va` (`image_base` plus `iat_rva`). `iat_va`
is relative to the `ImageBase` the file declares, which is where a provider
loads the image unless its database was rebased. Pass `iat_va` to `xrefs` and
other provider tools for a database at the file's base. For a rebased database,
such as an IDA database moved before REA attached, add `iat_rva` to the base
that provider reports for the image instead; REA does not observe that base
from the file.
`import_directory` and `delay_import_directory` report the data directory RVA
and size, or `null` when a directory is absent or zero. Their `locations` are
the file spans actually read for the descriptor array and its terminator. When
consecutive descriptors map to discontiguous file bytes (for example across a
section boundary), each span is reported separately, and each becomes its own
Evidence file-offset range.
If the first descriptor cannot be examined, the directory declaration remains
present with no consumed `locations`, and coverage is partial. Descriptors,
thunks and NUL-terminated names stay within PE's 32-bit RVA space, including
PE32+ images. Like the Windows loader, descriptor walks continue to the null
descriptor past a short declared directory `Size`; that `Size` is reported in
`header_anomalies`. See
[PE header admission](guides/native/binary-diagnostics.md#pe-header-admission).

`machine` retains the original unsigned COFF value. `architecture` decodes
known machines, including ReadyToRun OS overrides when a CLI directory is
declared; that declaration does not establish valid CLR metadata or runtime
compatibility. Unrecognized machines retain `pe-machine-<decimal>` while their
import tables remain inspectable. A recognized machine whose width contradicts
the optional header is malformed.

Each `imports[]` item reports the DLL name, descriptor RVAs, and named or
ordinal functions with ILT/IAT RVAs. `delay_imports[]` reports RVA-based
delay-load descriptors separately. `imphash` is pefile's `get_imphash()` over
the standard import table only; delay-load rows do not participate. Ordinal
imports use pefile's ordinal name tables and otherwise its `ord<decimal>`
fallback.

`imphash.md5` is `null` with a `reason` whenever the value would not be
pefile's hash of this image: the standard import table is partial, or pefile
would read a different row sequence (names it treats as invalid or truncates,
ordinal 0, descriptors without functions, or tables its bounds and import
symbol cap truncate). Delay-load issues do not withhold the hash.

Import inspection uses a forensic file-backed RVA mapping that can include raw
alignment bytes beyond a section's `VirtualSize`. The hash compatibility check
compares the consumed spans with pefile's section selection and raw read bounds.
A matching hash describes that on-disk import stream.
[pefile 2024.8.26 section mapping](https://github.com/erocarrera/pefile/blob/v2024.8.26/pefile.py#L1104-L1201)

A missing import directory is observed absence of that table. It is not proof
the image never imported APIs through another table or overlay.

## Limits and failures

The reader reads at most 64 MiB by default (`max_file_bytes`, 512 MiB maximum;
see [read allowance](reference/limits-and-recovery.md#static-reader-read-allowance)), whatever the file size. At most
256 import and delay-load descriptors are examined by default (4096 maximum),
and at most 8192 functions across every table (262144 maximum). Malformed PE
headers and exhausted DLL or function budgets fail without partial success.
Decoded DLL and function names are limited to a fixed 16 MiB of retained text
with no runtime override; `max_file_bytes`, `max_dlls` and `max_functions` do
not raise it. Resource failures report the exhausted allowance as `limit`
(`dlls`, `functions` or `retained_text`) with matching recovery.

Unreadable DLL names, hint/name entries, thunks, or descriptors are reported as
partial coverage with `issues`. A
descriptor whose required table RVA is zero (a
standard `FirstThunk`, or a delay-load import address or name table) is
reported as `malformed_entry` with no functions, never as a complete empty
inventory. Delay-load descriptors that store virtual addresses rather than RVAs
are recorded as `unsupported_form` and are not decoded.

This workflow does not resolve bound imports, loaded IAT contents, or
export-forward names in another DLL.
