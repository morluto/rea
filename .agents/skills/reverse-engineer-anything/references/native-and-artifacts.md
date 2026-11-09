# Native and managed analysis

<a id="native-managed-and-packaged-artifacts"></a>

Read only the sections needed for the selected task.

- [Other artifact guides](#other-artifact-guides)
- [Apple app resources](#apple-app-resources)
- [Desktop installation directories](#desktop-installation-directories)
- [Native targets](#native-targets)
- [Continue editable Ghidra analysis across processes](#continue-editable-ghidra-analysis-across-processes)
- [Reuse caller-selected Ghidra analysis](#reuse-caller-selected-ghidra-analysis)
- [Ghidra startup deadline recovery](#ghidra-startup-deadline-recovery)
- [Bridge request ceiling](#bridge-request-ceiling)
- [Selected native facts and call graphs](#selected-native-facts-and-call-graphs)
- [Static memory and original file bytes](#static-memory-and-original-file-bytes)
- [DOS MZ with Ghidra](#dos-mz-with-ghidra)
- [Managed PE/CLI](#managed-pe-cli-guide)
- [DOS COM loader interpretation](#dos-com-loader-interpretation)
- [Function annotations in Ghidra](#function-annotations-in-ghidra)

For release comparisons on one MCP connection, retain `list_procedures` Evidence
from each target and reuse its exact IDs after target switches or `close_binary`.
For a handoff or new process, export the complete bundle and import it there,
including its source closure. `reset_investigation` explicitly clears retained
records; optional `save_path` checkpoints them before clearing.
`match_native_functions` pairs unique exact names and, when supplied,
complete observed body bytes. Reuse optional same-context `list_names`,
`procedure_info`, `read_bytes` and existing `analyze_function` dossiers as
`left_observations`/`right_observations`; an MCP `analyze_function` summary
reply contributes its `parent_evidence_id` as a `retained-evidence` reference,
not the summary itself. Avoid decompiling every function merely to match it. Its summary retains a parent for
`inspect_analysis_view` `function-matches` collections `matches` and `functions`.
Select columns, batch IDs and page individual facts; aliases remain unresolved.
Unpaired observations do not prove additions/removals. Existing matched dossier
pairs include inputs for `compare_functions`; otherwise analyze just chosen pairs.

Aggregate completed comparisons with `find_changed_behavior`, selecting each
comparison's exact `retained-evidence` ID instead of resending full records.
Inline comparison Evidence remains accepted. References belong to the current
server: after handoff, import the original bundle including its source closure.
Do not substitute dossier IDs or summary views. Static differences remain
behavior candidates, with runtime behavior unknown unless separately observed.

For a matching representation refusal, inspect `details.limit` and raise
`native.matching_representation_bytes` with `update_analysis_settings` before
retrying the unchanged MCP request. CLI launch seed:
`REA_NATIVE_MATCHING_REPRESENTATION_BYTES`. The default is 96 MiB; the policy
range is 1 byte to 1 GiB and does not bound process RSS. Keep the complete
inventories: splitting them changes global name/body uniqueness.

## Apple app resources

Use `open_bundle_resources` with the selected app path, then `inspect_plist`,
`decode_interface_builder`, `inspect_asset_catalog`, or `inspect_keyed_archive`.
The resource session reads the app without resolving `CFBundleExecutable` or
starting a deep provider. Preserve `resource_root` provenance, per-resource
hashes where reported, and null executable identity; a directory path is not
an executable digest. Export retained Evidence before closing or switching
roots. Binary analysis snapshots do not apply. Use `open_binary` to switch to
executable analysis, and `close_binary` to release either session kind.

The four matching CLI commands accept the app path directly. For an archive
inside the app, use `inspect-keyed-archive APP_PATH RELATIVE_ARCHIVE_PATH`.
Host requirements for plist and compiled asset/Interface Builder tooling still
apply; a resource-only session does not establish provider availability.

## Desktop installation directories

When an installation directory is supplied and its runtime is unknown, use
`inspect_desktop_application` with its absolute path. Default MCP summary
delivery retains complete Evidence. Read `files`, `omissions`, `candidates`, `components` or
`next_probes` with `inspect_analysis_view` kind `desktop-application`, selecting
exact paths, batched file/omission IDs or families and only needed fields and pages.
Summary `probe_issues` retains counts and bounded previews. Select files with
`has_issues: true` and fields `path`, `read_status`, `issues` to retrieve exact
failures directly; preview text is display data, while `file_id` selects full facts. Preserve source
coverage, read-range identity and unknowns; directory snapshot identity is not
a digest of every file's contents. Component path markers do not establish
runtime presence. For compact CLI output, use
`inspect-desktop-application PATH --detail summary --evidence_output BUNDLE`.
See [desktop installations](https://github.com/morluto/rea/blob/main/docs/desktop-applications.md).

## Native targets

For an existing IDA MCP configuration, use `open_binary` with the original
input binary and `provider_id: "ida"`; do not pass an `.idb` or `.i64` database.
The legacy attached profile binds the already-open GUI input by SHA-256 and
leaves its database open. The modern headless profile creates and closes an
owned private database without saving. Installation and registration reuse
[mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp); see the
[IDA provider guide](https://github.com/morluto/rea/blob/main/docs/providers/ida-provider.md).
For migration to the separate native IDA MCP plugin, follow the guide's
[legacy attached migration](https://github.com/morluto/rea/blob/main/docs/providers/ida-provider.md#migrate-a-legacy-attached-registration).
Replace the upstream registration explicitly; modern mrexodia tools are not the
native profile. Native attachment preserves the database but does not provide
direct callers; check session availability and the guide's verification limits.
Proceed directly to `analyze_function`, pseudocode, or function/string searches
after opening; IDA does not supply `binary_overview`. Consult session availability
when composing broader workflows. Modern direct callers and unsupported dossier
facets remain unknown; live IDA results are not replayed from snapshots.

With `REA_KUNA_COMMAND` configured, `provider_id: "kuna"` answers procedure
lists, lookups, pseudocode, assembly and `analyze_function` from Kuna's cached
whole-program export. Callers/callees use a separate body-free graph shared by
the session; `xrefs` returns exact-address incoming sites and filters forwarding
aliases. These queries and inventory lookups do not trigger a C export. Indirect
targets remain unknown and can make relationship coverage partial. Reference
caches expire on close; a fresh CLI process repeats the native reference walk.
Typed references, CFG, raw-memory tools and annotations remain unsupported. A cold first
answer can come from a single-function run (its limitations say so); assembly
waits for the export. For pseudocode and assembly, `raw_result.source` names the
cached `.c`/`.asm` file and byte span, which you may search directly instead of
calling per function. See the
[Kuna provider guide](https://github.com/morluto/rea/blob/main/docs/kuna-provider.md).

After `open_binary`, use focused search, procedure, or function tools directly.
Use `binary_overview` when target metadata or inventory context helps answer the
question. Prefer literal search, names, decompilation, callers, callees, and
cross-references. Addresses and recovered pseudocode are analysis observations,
not original source. Provider unavailability and unsupported metadata remain
unknown rather than false.

For large pseudocode, request `procedure_pseudo_code` with `detail: "summary"`
on the first MCP call. It retains the complete observation and returns the
original selection, text availability and length without the body. Use
`normalized_result.parent_evidence_id` with `inspect_analysis_view` and
`view: {kind: "native", facet: "pseudocode", offset: 0, limit: 20000}`;
follow `coverage.next_offset` for later pages. Choose a smaller limit if one
page exceeds the client or transport budget. Offsets and limits count UTF-16
code units, not lines or tokens. Pages reuse the same observation without
repeating decompilation. Null and empty text remain distinct. Omitted or
`complete` detail preserves full inline delivery. Summary delivery requires a
retaining session and does not reduce the work or memory of decompilation.

For a completed `analyze_function` dossier, use `inspect_analysis_view` with
`view: {kind: "native", facet: "value_flow_operations", offset: 0, limit: 32}`
and the exact retained Evidence ID to read selected facts without reanalysis.
The default MCP reply is already a summary of that dossier: its
`normalized_result.parent_evidence_id` is the retained ID to page, and its
null counts mark facets the provider did not record or declared unavailable.
Native facets also include procedure, pseudocode, assembly, basic blocks,
comments, callers/callees, references, unresolved calls, referenced strings and
names, the native API record, and value-flow summaries. Pseudocode offsets and limits count UTF-16
code units; use the returned `next_offset` for continuation. Provider limitations
and unavailable facts remain explicit; the complete parent Evidence is retained.

`inspect_macho` on a large framework returns megabytes of imports and exports.
Select `detail: "summary"` for slice identity, UUID and per-collection counts,
then page rows with `view: {kind: "macho", facet: "exports", offset: 0, limit: 64}`
and `normalized_result.parent_evidence_id`. Facets are entrypoints,
architectures, build_metadata, load_commands, dependencies, imports, exports,
segments and provenance. `source_exhaustive: false` means unreturned symbols
may exist.

To see which functions or Objective-C methods a Mach-O actually calls in one
run, use `observe_native_calls` with explicit breakpoints and a bounded
`duration_ms`/`max_events`. It launches a new process under LLDB, so the target
runs and may change files or use the network. Hardened-runtime targets need the
`get-task-allow` entitlement.
Function breakpoints use exact LLDB runtime names: pass an `inspect_macho` export
or import `runtime_name` (`main`), not its symbol-table `name` (`_main`). REA does
not translate breakpoint names. Set `module` to the image
file name when selecting that image only; otherwise loaded system images also
match. Inspect retained locations and module paths before attributing a call.

Use `binary_session` with no arguments to check the open target, selected
provider, and alignment. Its default summary `result.tool_availability` carries
the complete tool inventory grouped by current status. Expand each group's
`names` and inherit the inventory-level client requirements unless a group
overrides them; availability, reasons, remediation, and modes remain inline.
Provider candidates keep availability and target-support status, code, and
reason. `omitted_fields` names what the summary leaves out; `{"detail":
"complete"}` adds each unavailable candidate's `remediation`, provider
diagnostics, candidate capability sets, and tool surface, `effects`, and
`annotations`. Those arrays name true flags from fixed
vocabularies, so an omitted known flag is false. `tools/list` remains the
canonical source for full tool schemas when target or provider state changes.

Provider capability groups carry provider identity and ordered limitations.
Prepend each set's `shared_limitations` to a group's `limitations` to recover the
operation's full ordered list. Candidate capabilities, returned with complete
detail, describe possible providers. Top-level session capabilities describe the current route, and
`analysis_provider_binding` identifies the selected provider.

## Continue editable Ghidra analysis across processes

For a task spanning agent sessions, check `binary_session` after selecting
Ghidra: the current provider's `capabilities[].shared_limitations` states whether
Program checkpoints are enabled or the session is ephemeral. Successful native
queries distinguish initial analysis from an actually restored packed Program;
do not infer that restoration happened merely because checkpoint mode is enabled.

In ephemeral mode, choose a private absolute directory and set
`REA_GHIDRA_CHECKPOINT_DIR` in the environment starting REA. Restart the MCP server
after changing that launch configuration; no current tool call or runtime
analysis-setting update enables it. Stock ELF/PE/Mach-O imports on Linux/macOS
are supported; see the [checkpoint setup and limitations](https://github.com/morluto/rea/blob/main/docs/getting-started/installation.md#automatically-checkpoint-an-owned-ghidra-program).

With the setting enabled, normal opens restore compatible saved Programs
automatically. Initial completed analysis is saved, and `close_binary` saves
later metadata edits; no separate save/restore tool is needed. Repair a reported
save failure and retry close. Cancellation or process failure can lose edits
after the last successful save; unfinished initial analysis cannot resume.
Keep the same checkpoint configuration for later processes. Evidence/Unknown
history and immutable REA query snapshots have separate persistence workflows.

## Reuse caller-selected Ghidra analysis

When the caller supplies an expanded project, configure `REA_GHIDRA_PROJECT_PATH`
(the `.gpr` marker) and optionally `REA_GHIDRA_PROGRAM_NAME` (one root program),
then restart/reconnect before `open_binary`. CLI uses the same configuration.
REA opens only a fingerprint-bound owned copy with `-process -noanalysis -readOnly`;
original project files are not opened by the engine or saved. Database edits,
import overrides and repair scripts are unavailable in this mode. Treat original
analysis completeness/settings as unknown and prior edits as caller-project state.
The program's recorded import digest must match the target; changed project content
requires reopening for a fresh profile. See the
[setup and preparation guide](https://github.com/morluto/rea/blob/main/docs/getting-started/installation.md#reuse-an-existing-ghidra-project).

## Ghidra startup deadline recovery

`provider_timeout` during the first Ghidra query can cover import, auto-analysis,
bridge startup, and readiness. The default 330,000 ms is configurable through
`REA_GHIDRA_STARTUP_TIMEOUT_MS`; a smaller query still needs the same cold import.

When the error names `ghidra.startup_timeout_ms`, call
`update_analysis_settings` with `action: "set"` and a larger value within the
reported bounds. Resolve retained cleanup before the next startup attempt.
No REA restart is needed; an already accepted startup keeps its original
budget. Follow the error's session-specific restart guidance, and preserve useful Evidence before closing
and reopening the target when remediation requires that lifecycle step.

For a per-function timeout, update `ghidra.decompile_timeout_seconds` and retry
the same function on the existing Program. Explicit `null` removes that
per-function deadline. Inspection is optional when the error supplies the
setting and bounds. Runtime updates disappear when REA exits; environment
changes only seed future REA processes.

The client's tool-call deadline must allow startup plus the requested query;
server settings and progress notifications cannot override it. CLI analysis
avoids the MCP client deadline, but retains the provider deadline. For example:

```sh
REA_GHIDRA_STARTUP_TIMEOUT_MS=1800000 rea analyze /absolute/path/to/app.exe --provider ghidra --json
```

Thirty minutes is an example budget, not a completion guarantee. Keep host CPU
and memory controls in place. Disable specific expensive analyzers only when
their missing coverage is acceptable and retain the resulting limitations.
Exported C and embedded resources remain useful independent evidence, but a
timeout does not establish complete analysis or absence of code. See the
[deadline and client guide](https://github.com/morluto/rea/blob/main/docs/reference/mcp-contracts.md#ghidra-first-query-deadlines-and-recovery).

## Bridge request ceiling

Hopper and Cutter share `REA_BRIDGE_MAX_REQUEST_BYTES`. Unset, both sides use
16777216 bytes. The payload budget excludes the terminating LF. A decimal
integer from 7464 to 536870887 raises or lowers that ceiling. The floor fits
the largest bounded symbol-name command. A tight Cutter status still returns
its session id and up to 64 completion receipts. Its path is included when it
fits, and is unknown when it does not, so an older descriptor path is not
paired with the new generation. The maximum is the encoded payload, one byte under Node's string ceiling so
the framing LF still fits. Cutter measures, signs, and writes a fitting
response in bounded chunks. The bridge searches only the newly read bytes
for the framing LF. The client unescapes each socket chunk into one response
string before parsing it, so this ceiling does not keep the paged wire frame
and another concatenated copy. Invalid values are configuration errors and do not fall back to 16777216. Set the variable in the environment that starts REA, restart REA,
and start Hopper or Cutter from that same environment. An out-of-band bridge
without the setting stays at 16777216 bytes. The client reports that mismatch
during discovery only after the hello proves a live authenticated bridge, and
does not send a status request or the command. A stale descriptor is ignored.
Discovery fails if any such live ceiling differs, even when another live
session matches. A command response discarded for that ceiling stays an
unknown execution with `output_truncated`. A hello
that never sends its authenticated frame does not hold the accept loop.
At most 8 connection threads run; a further accept is closed, and a failure
to start a thread does not stop the listener. `completed_connection` is the
longest prefix of connections that have terminated. Dense scalar replies are
encoded in bounded batches.
The 25000 ms Cutter request deadline and the 256-candidate discovery budget
still have no runtime override.

## Selected native facts and call graphs

For a large `get_call_graph`, or repeated `procedure_address`,
`procedure_callees`, `procedure_callers` and `resolve_containing_procedure`
queries, select `detail: "summary"` when the first 64 recorded observations
suffice. Read further `native-observation` pages from the returned parent Evidence
ID. Graph message IDs index that page's exact-text dictionary; keep level,
source index, failed nodes, and partial/unknown relationship coverage.
Read referenced source context through `native-context` facets `overview`,
`analysis-profile`, `limitations` and `result-limitations`. Reuse inspected
context/profile values only for the same digest; until caveats are read,
interpretation beyond the returned facts remains unknown. Complete Evidence
remains retained and exportable. Small complete replies can cost fewer tokens
than additional context/page calls; count the completed task and discovery.

## Static memory and original file bytes

For Ghidra, `read_bytes` reads initialized analysis memory, including loader
fixups; it does not read a running process. Check `returned_bytes` and `complete`
before decoding a table. An incomplete read is missing coverage, not a zero-filled
tail. Use `list_segments` to inspect the selected block's initialization and address-space
facts, and retain unavailable facts as unknown.

Use `address_to_file_offset` to anchor one observed address to original file
bytes. A mapping for the first address does not establish a contiguous mapping
for an entire table, and loader fixups can make analysis bytes differ from source
bytes. Keep source ranges and analysis-memory observations separate.

A pointer table can refer to writable slots populated by a constructor rather
than directly to immutable resources. An uninitialized block or an observed zero
does not establish the slot's later runtime value. Follow `xrefs` and the relevant
writer's assembly or pseudocode; distinguish recorded assignments from inferred
execution order. Do not replace unreadable bytes with zeros or conclude that a
resource is absent without the necessary initialization evidence.

## DOS MZ with Ghidra

For an admitted DOS MZ target, use `inspect_native_load_image` to check measured
loaded bytes, file mappings, relocations and the entry against the immutable
snapshot. Keep `mismatch` and `unsupported` explicit. Verified import covers the
reported static image, not runtime DOS or PC-98 hardware behavior.

For a large load-image report, select `detail: "summary"` and query its
`parent_evidence_id` with `inspect_analysis_view` kind `native-load-image`.
Choose a collection such as `relocations` or `mappings`, select only needed
fields, and page with offset/limit. Original indices preserve same-address
alternatives. Null collections remain unrecorded or inapplicable; paging does
not upgrade unsupported verification. CLI requires `--evidence_output` for
summary delivery so complete source Evidence remains accessible.

For Ghidra decompilation, `procedure_pseudo_code` also accepts `procedure: "file-offset:0x..."`; CLI `rea decompile <path> --file-offset=0x... --provider ghidra` resolves the source byte offset internally. An unresolved 0x-prefixed numeric procedure selector also falls back to a unique file mapping. Existing symbols and analysis addresses win; multiple mappings fail as ambiguous. Preserve the returned file-offset and address locations and raw selection observations. ELF virtual addresses are distinct from file offsets; never assume an arbitrary offset plus image base is an analysis address.

Complete function body ranges use inclusive ends and can contain gaps. Do not
treat the enclosing span as code.
For packed targets, retain the original and separately derived artifact identities;
decompiling an unpacking stub does not recover the unpacked program.

When reading Objective-C dispatch metadata, distinguish class implementation
methods from protocol requirements: class methods report null requirement
flags, while decoded protocol declarations retain required and optional facts.
Property attributes remain raw name/value tokens; use the property's
`atomicity` field for the decoded `N` marker or the default atomic behavior.
Null class/meta flags, ivar counts, atomicity, or read-only values mean the
selected provider did not establish that fact. Symbol names alone do not prove
that a class is a root class or has no ivars.

<a id="managed-pe-cli-guide"></a>

## Managed PE/CLI

Start with `inspect_managed_artifact`. REA's canonical managed inspection is
execution-free: do not claim it loaded, reflected, executed, or resolved the
assembly. Keep managed/native boundaries and unavailable reconstruction facts
explicit. A bring-your-own reconstruction oracle is separate from the canonical
parser and must not become an implicit setup dependency.

For identity/classification questions, `inspect_managed_artifact` can explicitly
select `detail: "summary"` on the first MCP call. It retains complete metadata
and returns a linked overview with full classification/evidence, nullable
module/MVID, frameworks, metadata coverage/issues/limitations and returned-row
counts. Default complete requests remain unchanged. Read original rows with
`inspect_analysis_view`, source `normalized_result.parent_evidence_id`, and
`view: {kind: "managed", collection: "attributes", offset: 0, limit: 16}`.
Collections are `references`, `resources` and `attributes`. Paging does not
repeat parsing. Returned-row exhaustion
does not prove complete metadata or absence under partial/unavailable coverage;
preserve build-local tokens and their artifact/MVID scope.

`inspect_managed_members` always returns the assembly-wide `member_refs`, even
for one selected type. For questions about a selected type, select
`detail: "summary"` with `type_names`; it returns the selection (with unmatched
names), coverage and per-collection counts. Page rows with
`view: {kind: "managed-members", collection: "call_edges", offset: 0, limit: 64}`
over `types`, `exported_types`, `fields`, `methods`, `member_refs`, `call_edges`,
`field_accesses` or `user_strings`.
Use exact `names` and `declaring_types` filters before paging supported
collections. For a compact method lookup, request `fields: ["name",
"declaring_type", "signature"]`; omit `body` to avoid anchors. Identity tokens,
original `source_index`, module/MVID and source coverage remain. Check
`unresolved_filter_rows` before interpreting an empty match as absence.

### .NET NativeAOT

NativeAOT binaries contain native machine code, so ordinary CIL decompilers
cannot recover the original method bodies. When managed metadata/CIL is absent,
classify that as a native-analysis route rather than claiming source recovery.
Open the native image with the selected deep provider and inspect functions,
strings, calls, and references; describe decompiler output as pseudocode and
inference.

NativeAOT images can be PE/COFF, ELF, or Mach-O executables and shared
libraries. Use file bytes and loader metadata rather than suffixes to identify
them. For packaged apps, inventory/extract with REA's artifact tools and retain
the exact contained image identity. PDB, ELF debug, or dSYM sidecars are
additional evidence only when the provider accepts and matches them.

REA has a built-in read-only snapshot parser for x64 PE targets with .NET 8 RTR
9.1 metadata. An optional headless Ghidra adapter adds database annotations and
broader metadata recovery on Linux; it requires an explicitly configured
NativeAOT JAR. These are separate routes. The built-in parser also runs on
Windows Ghidra P0; read frozen literals from its report, because
`search_strings` does not include them. See the
[NativeAOT guide](https://github.com/morluto/rea/blob/main/docs/providers/ghidra-nativeaot.md)
for setup, supported layouts, and host restrictions. Preserve binary identity
and distinguish derived metadata from Ghidra database observations. Recovered
types and native pseudocode are not original C# source. Windows Ghidra P0 has
no database mutation authority.

For headerless firmware and address-bearing containers, read
[raw images](firmware-and-raw-images.md#headerless-raw-images-and-firmware-containers).

## DOS COM loader interpretation

For headerless DOS COM, explicitly open with `format: "dos-com"` (CLI
`--target-format dos-com`). Inspect the load image before trusting function
analysis: the entry is `0x10100`, file offset zero, with imposed real-mode segment
context. PSP/stack/device state remains unmodeled. See [DOS guide](https://github.com/morluto/rea/blob/main/docs/providers/ghidra-dos.md).

## Function annotations in Ghidra

Fresh-import sessions admit annotations; existing-project reuse is read-only.
Use `annotate_native_function` for one function name and/or entry comments, with at least one explicit change. Review its annotation readback and refreshed dossier inline. Changes are atomic; empty comments clear them, omitted fields preserve them. Later MCP calls observe edits. Normal close saves them when owned Program checkpoint mode is enabled; ephemeral mode discards them. CLI `annotate-native-function` follows the same setting when closing after its updated result. Select the [checkpoint workflow](#continue-editable-ghidra-analysis-across-processes) before edits that must survive a later process. Original executable bytes are unchanged; edits invalidate immutable snapshots. Windows P0 does not admit database mutations. For naming only, `set_address_name` / `set_addresses_names` also work with Ghidra: they name function entries or data addresses (primary labels) and return compact per-address success booleans instead of a dossier. Ghidra rejects batch addresses that request the same name or a name another selected address holds; `raw_result.failures` gives each failure's reason.

A provider switch or different target can retire the active Ghidra database and discard
its edits, even if the new provider fails on a later call. Same-target,
same-profile reopen keeps the active database. Retained annotation Evidence
records what happened; it does not restore the edits.

For `compare_functions`, obtain `analyze_function` Evidence before and after the
edit while the MCP session is open; annotation Evidence is not a comparison
input. Export the needed Evidence before close if comparison will happen later.
Authenticated same-artifact coordinates preserve renamed entries as
`matched / same-entry`, with the canonical `entry_address` inline; name and
exact-text changes remain separate dimensions. This requires compatible
architecture, provider-owned mapping and selected-image commitments. Equal
numeric addresses alone cannot establish correspondence; inspect retained
source Evidence and coverage when the match remains ambiguous.

## Other artifact guides

Read the owning page for offline formats, containers or firmware. These explicit
anchors preserve older links without creating duplicate searchable sections.

- <a id="go-build-metadata"></a>[Go build metadata](format-inspectors.md#go-build-metadata)
- <a id="model-files"></a>[Model files](format-inspectors.md#model-files)
- <a id="il2cpp-metadata"></a>[IL2CPP metadata](format-inspectors.md#il2cpp-metadata)
- <a id="rust-dependency-metadata"></a>[Rust dependency metadata](format-inspectors.md#rust-dependency-metadata)
- <a id="pe-authenticode-certificate-tables"></a>[PE Authenticode certificate tables](format-inspectors.md#pe-authenticode-certificate-tables)
- <a id="pe-import-and-delay-load-tables"></a>[PE import and delay-load tables](format-inspectors.md#pe-import-and-delay-load-tables)
- <a id="pe-tls-callbacks-and-load-configuration"></a>[PE TLS callbacks and load configuration](format-inspectors.md#pe-tls-callbacks-and-load-configuration)
- <a id="binary-hardening"></a>[Binary hardening](format-inspectors.md#binary-hardening)
- <a id="elf-note-tables"></a>[ELF note tables](format-inspectors.md#elf-note-tables)
- <a id="apple-ips-crash-reports"></a>[Apple IPS crash reports](format-inspectors.md#apple-ips-crash-reports)
- <a id="linux-kernel-modules"></a>[Linux kernel modules](format-inspectors.md#linux-kernel-modules)
- <a id="cpython-pyc-files"></a>[CPython pyc files](format-inspectors.md#cpython-pyc-files)
- <a id="erlang-beam-files"></a>[Erlang BEAM files](format-inspectors.md#erlang-beam-files)
- <a id="sqlite-snapshots"></a>[SQLite snapshots](format-inspectors.md#sqlite-snapshots)
- <a id="recorded-linux-crashes"></a>[Recorded Linux crashes](format-inspectors.md#recorded-linux-crashes)
- <a id="offline-elf-layout"></a>[Offline ELF layout](format-inspectors.md#offline-elf-layout)
- <a id="offline-wasm"></a>[Offline WASM](format-inspectors.md#offline-wasm)
- <a id="offline-apk-signatures"></a>[Offline APK signatures](format-inspectors.md#offline-apk-signatures)
- <a id="packages-and-extraction"></a>[Packages and extraction](packages-and-archives.md#packages-and-extraction)
- <a id="offline-pe-resource-inventory"></a>[Offline PE resource inventory](format-inspectors.md#offline-pe-resource-inventory)
- <a id="offline-pe-and-elf-export-tables"></a>[Offline PE and ELF export tables](format-inspectors.md#offline-pe-and-elf-export-tables)
- <a id="godot-pck"></a>[Godot PCK](packages-and-archives.md#godot-pck)
- <a id="esp-images"></a>[ESP images](firmware-and-raw-images.md#esp-images)
- <a id="esp-flash-images"></a>[ESP flash images](firmware-and-raw-images.md#esp-flash-images)
- <a id="bun-standalone-executables"></a>[Bun standalone executables](packages-and-archives.md#bun-standalone-executables)
