# Binary hardening

Use `inspect_binary_hardening` to read compile-time and link-time hardening from
an explicit local ELF, PE, or Mach-O file. No disassembler, pwntools install, or
target execution is required. Universal Mach-O files return one image per slice.

```sh
rea inspect-binary-hardening /absolute/path/to/program --json
rea inspect-binary-hardening /absolute/path/to/program --max-file-bytes 1048576 --json
```

MCP accepts `{ "path": "/absolute/path/to/program" }`. CLI paths may be relative
to the current directory; MCP paths must be absolute.

Each image has one row per property: `property`, `state`, `confidence`, `basis`,
`location`, `note`, and `next_probe`. States are `enabled`, `disabled`,
`partial`, `unknown`, and `not_applicable`. `confidence` is `observed` for a
single header or import, and `derived` when the state combines several fields,
such as ELF PIE or full RELRO. An image's `architecture` is its CPU family, or
null when REA has no family for it. `machine` and `slice.architecture` keep the
exact identity, such as `arm64e`.

ELF rows cover PIE (`ET_DYN` with `PT_INTERP` or `DF_1_PIE`), NX (`PT_GNU_STACK`;
a missing header is `unknown` and the architecture default is only noted), RELRO
(`PT_GNU_RELRO` plus `BIND_NOW`), stack protector and FORTIFY undefined dynamic
imports, CET and AArch64 BTI/PAC GNU property notes, `DT_RPATH`, `DT_RUNPATH`, and
whether a `SHT_SYMTAB` section is present. Only an undefined dynamic import
counts. Imports come from the table `DT_SYMTAB` declares. A `SHT_DYNSYM` section
only supplies the symbol count when `DT_HASH` and `DT_GNU_HASH` leave it open,
and only if it names the same symbol and string tables. Without that count the
import rows are `unknown` and give the reason. A missing `__stack_chk_fail` or fortify import is `unknown`. That
absence does not establish that the protection was left out of a static or
stripped build. A present import is a sign that some code uses the protection,
not proof that all code does. NX, RELRO, `DT_RPATH`, and `DT_RUNPATH` are
`not_applicable` when `e_type` is neither `ET_EXEC` nor `ET_DYN`, and `unknown`
for a linked image with no readable program headers.

PE rows read `DllCharacteristics` for dynamic base, high-entropy VA, NX
compatibility, force integrity, no SEH, and guard CF. `cfg_instrumented` is the
load-config `GuardFlags` linker claim when `Size` covers that field. An
unreadable load configuration, including a TLS failure in that parser, leaves
only `cfg_instrumented` `unknown`. Authenticode and debug rows report certificate
and debug directory presence, not signature validity or debug content. A
directory whose address and size disagree is `unknown`.

Mach-O rows read `MH_PIE`, `MH_ALLOW_STACK_EXECUTION`, `MH_NO_HEAP_EXECUTION`,
an `__RESTRICT` segment, `LC_CODE_SIGNATURE` presence, encryption from the
existing encryption reader, the arm64e subtype, and a stack-protector import.
`hardened_runtime` is `unknown` with `next_probe` `inspect_signature`.
CodeDirectory flags stay with that tool.

The report states presence of build-time features. It does not state
exploitability. `inspect_binary_layout` is unchanged.

The default read budget is 64 MiB (`max_file_bytes`, ceiling 512 MiB). A changed
file is refused. A malformed header, or a program or section payload declared
outside the file, returns no partial report, except that one bad slice in a universal Mach-O leaves the other slices. A symbol table or
symbol name over its budget leaves the import rows `unknown` and keeps the
header rows. A GNU property note over its budget, or a compressed note section
that may hold one, leaves the CET and BTI/PAC rows `unknown` and keeps the header
rows. A dynamic-table budget still fails the ELF report. The image is never
executed.
