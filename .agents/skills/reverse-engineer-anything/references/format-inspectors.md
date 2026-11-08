# Offline format and metadata inspection

Read only the sections needed for the selected task.

- [Go build metadata](#go-build-metadata)
- [Model files](#model-files)
- [IL2CPP metadata](#il2cpp-metadata)
- [Rust dependency metadata](#rust-dependency-metadata)
- [PE Authenticode certificate tables](#pe-authenticode-certificate-tables)
- [PE import and delay-load tables](#pe-import-and-delay-load-tables)
- [PE TLS callbacks and load configuration](#pe-tls-callbacks-and-load-configuration)
- [Binary hardening](#binary-hardening)
- [ELF note tables](#elf-note-tables)
- [Apple IPS crash reports](#apple-ips-crash-reports)
- [Linux kernel modules](#linux-kernel-modules)
- [CPython pyc files](#cpython-pyc-files)
- [Erlang BEAM files](#erlang-beam-files)
- [SQLite snapshots](#sqlite-snapshots)
- [Recorded Linux crashes](#recorded-linux-crashes)
- [Offline ELF layout](#offline-elf-layout)
- [Offline WASM](#offline-wasm)
- [Offline APK signatures](#offline-apk-signatures)
- [Offline PE resource inventory](#offline-pe-resource-inventory)
- [Offline PE and ELF export tables](#offline-pe-and-elf-export-tables)
- [EVM bytecode](#evm-bytecode)
- [Embedded GPU code objects](#embedded-gpu-code-objects)

## Go build metadata

Use `inspect_go_binary` for an explicit local ELF, PE or Mach-O (universal
files need `architecture`) when the
question concerns the embedded compiler version, module/dependency versions,
local replacements or build settings. No `open_binary`, Go installation or
target execution is required. The CLI equivalent is `inspect-go-binary PATH`.
Preserve artifact SHA-256, original file ranges, framed module bytes and every
unparsed module-text line. A missing record is an unknown, not proof of a
non-Go binary; observed metadata does not authenticate its claims. Function,
source and type recovery remain a separate native-analysis question.

See the [Go binary guide](https://github.com/morluto/rea/blob/main/docs/guides/native/go-binaries.md).

## Model files

Optional `view` selects one page in the initial call. Batch metadata keys or
tensor names and select only needed fields; do not infer model behavior from
declared architecture or tensor types.

Use `inspect_model_artifact` (`inspect-model-artifact PATH`) for local GGUF v2/v3
and safetensors declarations without a model runtime. Header-only mode does not
read weights or establish full-file identity. `hash: "full"` explicitly streams
all bytes. Retained `model-artifact` views page `metadata`, `tensors` and derived
`types`, with exact batch filters and selected fields. Arrays retain typed counts
and eight-element previews; omitted values, unknown types and runtime behavior
stay explicit. See [model files](https://github.com/morluto/rea/blob/main/docs/model-artifacts.md).

## IL2CPP metadata

Use `inspect_il2cpp_metadata` for an explicit local Unity `global-metadata.dat`
(versions 24, 27, 29, 31 and 39) when the question concerns assembly images,
names, member owners, string literals, namespaces or index ranges. No `open_binary`, Unity installation or target
execution is required. The CLI equivalent is `inspect-il2cpp-metadata PATH`.
MCP defaults to counts with complete retained Evidence. Query `sections`,
`images`, `types`, `methods`, `fields`, `properties`, `events`, `parameters` or
`string_literals` through `inspect_analysis_view`; use exact names,
batch indices and selected fields. Row indices are scoped by artifact SHA-256
and collection; page offsets count filtered matches. Parameters support batch
`method_indices` to read one method's parameters directly. Historical reports
without member collections retain unknown counts rather than empty inventories. Preserve
artifact SHA-256 and index widths. Unrecognized magic may mean encryption and
is unsupported, not decrypted.

Optional matching `binary_path` enables static native addresses and type
references. Query `method_addresses` with indices or addresses/states, preserving
every shared-body method and both artifact identities. Without a linked binary,
native counts remain unknown. Byte-pattern fallback is inferred; no runtime
behavior or same-build pairing is proved.
See [IL2CPP metadata](https://github.com/morluto/rea/blob/main/docs/il2cpp-metadata.md).

## Rust dependency metadata

For selected crates, use `view: {collection: "packages", names: [...],
fields: ["name", "version", "source"]}` on the first call. Include `dependencies`
explicitly for direct index references. Select `detail: "summary"` for counts and
ranges; retained Rust package/edge views support later filters. Keep complete
parent Evidence accessible; CLI compact delivery requires `--evidence_output`.

Use `inspect_rust_binary` for an explicit local ELF, PE, or Mach-O (universal
files need `architecture`) when
the question concerns the cargo-auditable crate list embedded in `.dep-v0`
(Mach-O: `__DATA,.dep-v0`). No `open_binary`, Rust installation, or target
execution is required. The CLI equivalent is `inspect-rust-binary PATH`.
Preserve artifact SHA-256, package order, dependency indices, and the section
file range. A missing section is null metadata, not proof the binary has no
dependencies. An omitted package kind stays null. A rustc commit hash is
inferred from a read-only `/rustc/<40-hex>/` path and does not by itself
identify the compiler. See [Rust binaries](https://github.com/morluto/rea/blob/main/docs/rust-binaries.md).

## PE Authenticode certificate tables

Use `inspect_pe_certificates` for an explicit local PE32/PE32+ image when the
question concerns the Authenticode certificate table, WIN_CERTIFICATE types, or
embedded PKCS#7 signer and X.509 identity fields. No `open_binary`, Windows SDK,
or target execution is required. The CLI equivalent is
`inspect-pe-certificates PATH`. Preserve artifact SHA-256, table file ranges,
payload hashes, original validity-time spellings, and
`subject_key_identifier_hex` when the signer uses that form. A missing
`IMAGE_DIRECTORY_ENTRY_SECURITY` directory is observed absence of that table,
not proof the image is unsigned in every catalog or overlay sense. Signatures,
chains, timestamps, and Authenticode digest coverage remain unobserved. See
[PE Authenticode certificate tables](https://github.com/morluto/rea/blob/main/docs/pe-certificates.md).

## PE import and delay-load tables

Use `inspect_pe_imports` for an explicit local PE32/PE32+ image when the
question concerns imported DLL and function names, ordinals, delay-load
descriptors, or the pefile import hash. No `open_binary`, Windows SDK, or
target execution is required. The CLI equivalent is `inspect-pe-imports PATH`.
Preserve artifact SHA-256, directory file ranges, original DLL spellings, and
ILT/IAT RVAs. A missing `IMAGE_DIRECTORY_ENTRY_IMPORT` directory is observed
absence of that table, not proof the image never imported APIs through another
table or overlay. Bound snapshots, loaded IAT contents, and export-forward
resolution remain unobserved. See
[PE import and delay-load tables](https://github.com/morluto/rea/blob/main/docs/pe-imports.md).

## PE TLS callbacks and load configuration

Preserve each callback's RVA, file offset and section alongside its VA and the
size-covered declaration fields. A missing directory is observed absence of
that declaration.

Use `inspect_pe_load_config` for an explicit local PE32/PE32+ image when the
question concerns code that runs before the entry point through TLS callbacks,
or the security cookie, SafeSEH, CFG, EH-continuation and XFG declarations in
the load configuration. No `open_binary`, Windows SDK, or target execution is
required. The CLI equivalent is `inspect-pe-load-config PATH`. Preserve artifact
SHA-256, directory and callback-array file ranges, and callback VAs as
hexadecimal strings. Fields outside the declared `Size` are `null`. Guard-flag
mitigations carry `evidence_kind: "inferred"`; enforcement remains unobserved.
See
[PE TLS callbacks and load configuration](https://github.com/morluto/rea/blob/main/docs/pe-load-config.md).

## Binary hardening

Each property reports `enabled`, `disabled`, `partial`, `unknown`, or
`not_applicable`, with the header field or import behind it.

Use `inspect_binary_hardening` for an explicit local ELF, PE, or Mach-O file
when the question concerns PIE or ASLR, NX, RELRO, stack-protector or FORTIFY
signs, control-flow flags, or stripped state. No `open_binary`, pwntools, or
target execution is required. The CLI equivalent is
`inspect-binary-hardening PATH`. Universal Mach-O files return one image per
slice. A missing import is `unknown`, not proof the protection was omitted.
Authenticode and Mach-O code-signature rows report presence, not validity.
`hardened_runtime` stays unknown and names `inspect_signature`. See
[binary hardening](https://github.com/morluto/rea/blob/main/docs/binary-hardening.md).

## ELF note tables

Retain each note's owner, type, descriptor SHA-256, and PT_NOTE/SHT_NOTE ranges.

Use `inspect_elf_notes` for an explicit local ELF32/ELF64 image when the
question concerns PT_NOTE/SHT_NOTE owners, GNU build-id, or GNU ABI-tag
fields. No `open_binary` or target execution is required. The CLI equivalent
is `inspect-elf-notes PATH`. Preserve artifact SHA-256, table file ranges,
descriptor hashes, and original owner spellings. A missing table is observed
absence of those declarations, not proof the image never carried notes in
another container. See
[ELF note tables](https://github.com/morluto/rea/blob/main/docs/elf-notes.md).

## Apple IPS crash reports

Use `inspect_apple_ips` for an explicit local Apple `.ips` file when the
question concerns crash metadata, exception and termination facts, threads,
usedImages, lossless registers, or documented crash classes. No `open_binary`,
Xcode, atos, or target execution is required. The CLI equivalent is
`inspect-apple-ips PATH`. Preserve artifact SHA-256, `bug_type` as a string,
uppercase image UUIDs, and integer literals that exceed IEEE-754 range. Only
`bug_type` `"309"` yields a crash body; other DiagnosticReports types return
no crash result. Opened Mach-O and dSYM UUID joins remain unobserved. See
[Apple IPS crash reports](https://github.com/morluto/rea/blob/main/docs/apple-ips.md).

## Linux kernel modules

Use `inspect_kernel_module` for an explicit local ELF32/ELF64 relocatable
object when the question concerns `.modinfo` license, vermagic, alias,
depends, or parm strings, the `__versions` symbol CRCs, or an appended module
signature trailer. No `open_binary`, Linux host, or `modinfo` program is
required. The CLI equivalent is `inspect-kernel-module PATH`. Preserve
artifact SHA-256, key order, duplicate keys, CRC hex, and section file ranges.
A missing section is observed absence when section names are known, not proof
the module never carried that metadata. `.gnu.linkonce.this_module` is reported
as present or absent; `struct module` stays unknown because its layout changes
with the kernel version. `__ksymtab` records are not decoded. The PKCS#7 range
and its SHA-256 are observed; certificate, signer, and digest coverage remain
unvalidated. An absent trailer is not proof the module is unsigned in another
container. gzip, xz, and zstd whole-file containers are unsupported and name
`external_decompression` as the next probe: use an external codec utility to
decompress into a separate file, then call `inspect_kernel_module` on that file. See
[Linux kernel modules](https://github.com/morluto/rea/blob/main/docs/kernel-modules.md).

## CPython pyc files

Use `inspect_python_pyc` for an explicit local CPython 3.7–3.13 `.pyc` when the
question concerns the header magic, PEP 552 source hash or timestamp, nested
code-object names, or bytecode identity. No `open_binary`, Python installation,
or target execution is required. The CLI equivalent is `inspect-python-pyc PATH`.
Preserve artifact SHA-256, the 16-byte header fields, nested code names, and
bytecode SHA-256. Bytecode is not decompiled. A decoded header does not prove
the matching `.py` is present. See [CPython pyc inspection](https://github.com/morluto/rea/blob/main/docs/python-pyc.md).

## Erlang BEAM files

Use `inspect_erlang_beam` for an explicit local `FOR1`/`BEAM` file when the
question concerns IFF chunks, atom names, exports, imports, lambdas, or the
Code header. No `open_binary`, Erlang installation, or bytecode execution is
required. The CLI equivalent is `inspect-erlang-beam PATH`. Preserve artifact
SHA-256, chunk file ranges, 1-based atom indices, and original atom spellings.
Missing optional tables stay null. For a few facts, use `detail: "summary"` with
a `beam` view selecting a collection, exact names/indices and fields; read later
pages from `parent_evidence_id` or the complete Evidence bundle. Same-name
exports retain every arity and original atom index. CLI summary delivery requires
`--evidence_output`. Null table counts remain distinct from decoded empty tables. See
[Erlang BEAM files](https://github.com/morluto/rea/blob/main/docs/erlang-beam.md).

## SQLite snapshots

Use `inspect_sqlite_database` with an explicit local database snapshot for its
schema and optional rows from one exact ordinary table. It requires Node.js
24.x >=24.15 or 26+ with the native `DatabaseSync.limits` API. It also consumes the
existing sibling `-wal`; retain both original digests when citing its result.
Default output is a compact inventory; a selected table expands only its own
schema and samples 20 rows. Select `columns` to avoid irrelevant or large cells,
and request `schema_scope: "database"` only for complete schema details.
Choose `row_limit` when a finite sample is useful and keep truncation and
unspecified row order explicit. Virtual tables, shadow tables and views are
schema facts, not row-read targets. REA inspects private copies and leaves
the source files untouched; obtain a coherent quiescent database/WAL snapshot
before inspection. See [SQLite snapshots](https://github.com/morluto/rea/blob/main/docs/guides/data/sqlite-databases.md).

## Recorded Linux crashes

Use `inspect_recorded_crash` with an explicit Linux x86-64 ELF core path to
inspect historical thread registers, signals, raw notes and original file
ranges. It is independent of the active disassembler target. Source-bound
register values and note bytes are observations; missing notes, signal-thread
association and current executable/library identity remain unknown. PIDs are
historical metadata and never authorize live attach or control.

The optional `include_debugger_context` facet adds mapping candidates through
caller-supplied GDB/pwndbg in an owned core-only session. Display names do not
establish current file identity; zero reported flags leave permissions unknown.
Requested unavailable context fails with setup guidance. See
[recorded crashes](https://github.com/morluto/rea/blob/main/docs/guides/native/recorded-crashes.md)
for exact upstream profiles, bounds and verification coverage.

## Offline ELF layout

Use `inspect_binary_layout` with an explicit local ELF path for file-backed
sections, symbols, relocations, linkage names, and static mitigation inferences
without opening a disassembler target. When that complete record is already
retained, call `inspect_analysis_view` for a summary, mitigations or linkage
facet, one section or symbol, or a stable page. Do not re-run the decoder to
read a single object.

## Offline WASM

Supply WABT 1.0.42 through `REA_WABT_BIN_DIRECTORY`. Select JavaScript glue and
candidate paths explicitly, preserving URL/path ambiguity and exact byte/tool
identity; no implicit fetch is performed.

Use `inspect_wasm_artifact` with caller-supplied WABT for selected local bytes.
For counts, validation and WAT identity, select `detail: "summary"` on the first
MCP call. The complete original Evidence stays retained; use
`normalized_result.parent_evidence_id` for exact exports or text pages. Omitted
or complete detail keeps the existing complete result.
For a completed result, use `inspect_analysis_view` with its reported retained
reference for a summary or `view: {kind: "wasm", facet: "exports", offset: 0, limit: 32}`.
Facets also include sections, imports, candidates, glue, WAT, headers, details
and tool profile. Text offsets count UTF-16 code units; follow `next_offset`.
The complete source remains retained after an oversized MCP reply. No target
execution or network acquisition is implied, and WAT is decoded representation.

For exact core-module import/export differences, use `compare_wasm_interfaces`
with two complete inspection Evidence records (or current-session retained
references) and explicit scope. Preserve unknown types/duplicate names; static
interface equality is not runtime compatibility. CLI accepts complete inline
Evidence in `rea compare-wasm-interfaces input.json --json`, or exact references
with `--evidence-bundle /absolute/path/evidence.json`. Use the complete parent
ID when the inspection returned a summary.

See the [WASM guide](https://github.com/morluto/rea/blob/main/docs/guides/wasm/wasm-artifacts.md).

## Offline APK signatures

Use `inspect_apk_signature` for a selected local APK/ZIP/AAB. Default MCP summaries
retain complete Evidence. Select `view.collection: signers/digests/lineage`,
with scheme or ID batches, fields and paging; use `inspect_analysis_view` kind
`apk-signature` for retained reads after deletion. IDs retain artifact/scheme
scope and signer links; `fields: []` keeps identity links. Empty pages preserve
partial decoding reasons and unknown authenticity. CLI compact delivery needs
`--evidence_output` to preserve the complete parent.
It reads the APK
Signing Block (v2/v3/v3.1) and v1 `META-INF` signing without executing anything,
and reports each signer's certificate facts (for v1, the certificate the PKCS#7
block's SignerInfo names), the declared v3 rotation lineage,
the declared source-stamp certificate and, for SHA-256/SHA-512 digests, whether
the declared content digest matches the current bytes. That match is not a
signature verification: anyone who changes the bytes can recompute the digest.
`posture` summarises v1-only signing (which cannot tell a v1-only APK from one
whose v2/v3 block was removed), observed signer agreement across schemes,
whether the v1 signer equals the block-scheme signer (`false` is notable),
whether every differing signer appears in a declared (unverified) rotation
lineage, and the strongest scheme.
It never claims authenticity: no signature or lineage is cryptographically
verified.

See the [APK signature guide](https://github.com/morluto/rea/blob/main/docs/apk-signature.md).

## Offline PE resource inventory

Use `inspect_pe_resources` with an absolute `path`, or
`rea inspect-pe-resources ./selected.exe --json`, for portable PE32/PE32+
resource inspection without opening a native target. Preserve returned Evidence:
type/name/language IDs and UTF-16 names, original directory/data/payload ranges,
code pages, payload hashes and static icon-group references. Same-language icon
resolution is explicit; missing references and size mismatch remain visible.
Other payloads are opaque, and this operation does not decode images or simulate
Windows resource loading. Consult the budgets and supported tree profile in
[offline binary diagnostics](https://github.com/morluto/rea/blob/main/docs/guides/native/binary-diagnostics.md).

## Offline PE and ELF export tables

Use `inspect_native_exports` with an absolute `path`, or
`rea inspect-native-exports ./libexample.so --json`, to read a PE export
directory or ELF dynamic symbol table on any host without opening a native
target. Ordinal-only, forwarded and hidden-version exports stay distinct;
partial or unsupported coverage means the inventory is incomplete, not that
exports are absent. Use `inspect_macho` for Mach-O. See
[offline binary diagnostics](https://github.com/morluto/rea/blob/main/docs/guides/native/binary-diagnostics.md).

## EVM bytecode

Explicit local EVM bytecode carrier: `inspect_evm_interface` with caller-selected
`raw` or `hex` encoding. The owned worker deadline is `timeout_ms` (default
30000 ms, range 1..2147483647, next call). It does not raise the fixed byte,
address-space, or CPU allowances. Preserve carrier/decoded digests and treat selectors,
argument strings and mutability as inferred candidates; this performs no chain
lookup or target execution. For the complete inferred interface without hex or
duplicate stdout, discover support and select `detail: "summary"`; complete
Evidence stays retained under its original identity. Use the returned
`parent_evidence_id` for exact function or `bytecode_hex`/stdout/stderr pages.
Candidate coverage does not establish interface completeness. See the
[EVM bytecode guide](https://github.com/morluto/rea/blob/main/docs/guides/evm/evm-bytecode.md).

## Embedded GPU code objects

Embedded CUDA/HIP code objects: `inspect_gpu_code_objects`; inventory targets
first, then decode selected payloads and query retained GPU Evidence.
