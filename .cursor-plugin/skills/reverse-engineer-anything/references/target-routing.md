# Target routing

Detailed routing for each target type: the first tool, its prerequisites,
how to page or select results, and what a result does and does not prove.
SKILL.md keeps the compact routing table; read the section for the target
at hand before calling its tool.

## Applications, packages and bundles

- ASAR or extracted JavaScript/Electron tree:
  `analyze_javascript_application`.
- Archive/package member inventory (ZIP/APK/IPA/MSIX/AppX, DMG, or a PyInstaller
  executable): `open_binary` with the supplied local path; use `inspect_artifact`
  when its graph and findings help answer the question. A PyInstaller CArchive
  is the application layer; the bootloader is only the native prefix. Start with
  `detail: "summary"` for large inventories, then use retained inventory views
  for selected member fields/pages. A complete small inventory can cost less
  than extra calls and schemas. Runtime options are metadata, not files.
  Compact delivery still inventories and hashes members. See the
  [Python packaged applications guide](https://github.com/morluto/rea/blob/main/docs/python-packaged-applications.md).
- Bun `--compile` executable: `open_binary`, then `inspect_artifact`; the Bun
  module graph is the application layer. Extract stored modules and analyze the
  JavaScript. See [Bun standalone executables](https://github.com/morluto/rea/blob/main/docs/bun-standalone.md).
- Deno `deno compile` executable: `open_binary`, then `inspect_artifact`; the
  embedded virtual filesystem is the application layer. Extract stored files and
  analyze compatible JavaScript. Environment-file values and CA certificate bytes
  are retained in local Evidence with their counts and byte lengths. The npm
  snapshot length is reported and not decoded, and the executable is not run. See
  [Deno compile executables](https://github.com/morluto/rea/blob/main/docs/deno-standalone.md).
- Apple app plist, Interface Builder, asset catalog, or keyed archive resources:
  `open_bundle_resources`, then the selected resource tool. This does not
  require `CFBundleExecutable` or a deep provider. Resource sessions have no
  executable digest or binary snapshot; use `open_binary` for native code.
- Android APK code, classes, methods, or incoming references:
  `inspect_android_package`, then focused Android tools when advertised.
  Archive member inventory still uses the archive route above.
- Managed PE/CLI assembly: `inspect_managed_artifact`.
- Firmware image: `inspect_firmware_regions` when advertised. Use
  `extract_firmware` when extraction is requested, with a caller-selected new
  absolute output directory. These tools use caller-supplied Binwalk/Unblob on
  Linux; see the [firmware guide](https://github.com/morluto/rea/blob/main/docs/guides/firmware/firmware-analysis.md).
- ESP32-family app or bootloader image (`0xE9` magic): `inspect_artifact`
  without a provider; see the ESP section of `native-and-artifacts.md`.
- .NET NativeAOT PE/ELF: native Ghidra analysis. Native code can yield pseudocode;
  consult the NativeAOT workflow in `native-and-artifacts.md` for
  optional metadata recovery and its supported host/layout boundary.
- Shipped application exposure for a local `.app`, install directory, ASAR, or executable: `audit_release_exposure` / `rea audit-release-exposure`. Each check has a stable id, a status, and fixed remediation. Unknown and unassessed checks stay in the report. This does not establish that an application is secure. Credential-marker hits report the rule id and location only. See [release exposure](https://github.com/morluto/rea/blob/main/docs/release-exposure.md).
- Explicit local Android APK (or ZIP/AAB) signing: `inspect_apk_signature`.
  Prefer its summary or selected signer/digest/lineage page; retain complete
  Evidence and use `inspect_analysis_view` kind `apk-signature` for follow-ups.
  Reports which schemes are present (v1 JAR, v2, v3, v3.1), each signer's
  certificate SHA-256 fingerprint (v1 included, from its PKCS#7 block), v3 key-rotation lineage, source stamp, and
  whether each signed digest still matches the bytes (self-consistency). This
  is identity and integrity, not a trust or authenticity verdict.
  See the [APK signature guide](https://github.com/morluto/rea/blob/main/docs/apk-signature.md).

## Runtime, browser and environments

- Native program behavior, live calls, instrumentation, or command-run effects:
  choose the matching [native runtime workflow](runtime-observation.md#native-runtime-questions).
  `open_binary` and `trace_native_values` establish static facts; they do not
  observe execution. Runtime tools have distinct launch, attach, mutation and
  cleanup effects, and do not require a preliminary static session unless their
  own contract says so.
- User-owned browser page already open: `list_browser_targets`.
- Passive traffic capture of a SPA: the default scope is the page's own origin,
  and data APIs usually live on another origin. Discover API origins from
  absolute URLs in loaded bundles or script text via JavaScript analysis tools
  (another passive capture without those origins still scopes to the page
  origin, and `completeness.excluded` counts lack URLs). Pass both the page
  origin and those API origins in `allowed_origins` — the list replaces the
  default scope — and read `completeness.excluded` before reporting that an
  API is absent. For long captures with body shapes, use
  `export_evidence_bundle` instead of expecting an inline result.
- Browser action the agent must perform (click, type, navigate):
  `capture_browser_scenario` with declared actions. See
  [runtime observation](runtime-observation.md) for connect/launch
  and the focused follow-up browser tools.
- Agent environment (AgentEnv bundle) of a web application: read
  [environments](environments.md) before recording; it records with
  `capture_browser_scenario` and writes the bundle with `export_environment_bundle`.
- Task for a desktop application's exported environment, from a
  `capture-desktop-application` folder: read
  [desktop application tasks](environments.md#tasks-for-a-desktop-application-environment).
- Environment of a Linux desktop app with a task, from a request such as
  "build me an Inkscape environment where the agent changes a poster's
  headline": read [desktop builds](desktop-build.md). You drive the
  app on a build computer from `start_build_computer`, then export and witness.
- User-owned Electron runtime already open: `list_electron_targets`. Before an electron-main Inspector attempt, check packaged fuses with `inspect_electron_fuses`; disabled `EnableNodeCliInspectArguments` means the app ignores `--inspect`.

## Network, packet and signal recordings

- Fiddler Everywhere traffic or a native `.saz` capture: read the
  [Fiddler workflow](runtime-observation.md#fiddler-everywhere-traffic-debugging).
  Inspect saved SAZ with `inspect_web_network_capture` and `format: "saz"`;
  connect Everywhere's separate MCP server for live traffic.
- Retained HAR/SAZ/native mitmproxy/aioquic qlog capture: `inspect_web_network_capture`. Select
  original record ordinals when useful; inspect producer fields and byte/number
  sidecars without fetching recorded URLs or claiming live attribution. HAR/SAZ/qlog
  old-generation heap is `REA_CAPTURE_DECODER_OLD_GENERATION_MIB` (default 192 MiB,
  floor 8, maximum 16384), set where REA starts. Host memory and `NODE_OPTIONS` do not
  raise it. See
  [historical captures](https://github.com/morluto/rea/blob/main/docs/guides/web/web-network-captures.md) for the exact upstream
  profile and credential exclusions. Qlog support starts with aioquic 1.5.0
  JSON 0.3; stream coverage and endpoint loss declarations do not recover bodies
  or establish network loss. Prefer detail summary, then kind qlog trace/stream
  pages; select one trace, stream ID and direction for contribution/range pages.
  Facts retain all-recorded-events-before-selection scope. Other qlog layouts
  and PCAP correlation are unsupported.
- Packet-field discovery: `inspect_packet_fields` searches installed protocols
  and field names/types before choosing fields for `inspect_packet_capture`.
  Query/page the relevant records; registrations do not establish observed traffic.
- Recorded packet captures: `inspect_packet_capture` with selected TShark fields,
  display filters and decode-as rules. Requires Linux, util-linux prlimit and
  TShark 4.x on an absolute `PATH` entry or via the optional absolute
  `REA_TSHARK_COMMAND` override; see
  [capture guide](https://github.com/morluto/rea/blob/main/docs/guides/data/packet-captures.md).
  Packet limits count input packets before filtering. Output defaults to 50 matching
  frames; use `match_offset` / `match_limit` for later pages, or explicit null
  limit for complete matching output. Preserve the source digest across pages.
  This does not perform live capture.
  For address/DNS/SNI/protocol summaries use `inspect_pcap_capture` with MCP
  detail summary, then retained kind pcap pages. Requires Wireshark 4.x tshark
  and capinfos, with Linux prlimit or Windows Job Objects; see
  [packet summaries](https://github.com/morluto/rea/blob/main/docs/guides/data/pcap-analysis.md).
  Select an exact DNS question for address pages; page exhaustion does not prove
  network completeness. This reads recordings and does not acquire traffic.
- Decoder discovery: `inspect_signal_decoders` searches installed decoder IDs
  or selected decoder help, including channels and options. Query and page the
  relevant details before choosing settings; this does not scan hardware.
- Recorded logic/signal traces: `decode_signal_recording` with explicit decoder,
  channel and protocol settings. On Linux with util-linux prlimit, supply sigrok-cli 0.7.2 through
  `REA_SIGROK_COMMAND`; see [recording guide](https://github.com/morluto/rea/blob/main/docs/guides/signals/signal-recordings.md).
  Output defaults to 50 literal lines; select annotation classes and page with
  `line_offset` / `line_limit`, or explicit null for all remaining output.
  Window counts are display lines, not annotations or samples. Preserve source digests across pages.
  This reads existing files; it does not acquire hardware signals.

## Bytecode, language runtimes and model files

- Explicit local WebAssembly artifact: `inspect_wasm_artifact`. Supply WABT 1.0.42
  through `REA_WABT_BIN_DIRECTORY`; retain exact byte/tool identity and decoded WAT.
  Select JavaScript glue and candidate paths explicitly and preserve URL/path
  ambiguity. No implicit fetch or target execution; WAT is not original source.
  See the [WASM guide](https://github.com/morluto/rea/blob/main/docs/guides/wasm/wasm-artifacts.md).
- Explicit local EVM bytecode carrier: `inspect_evm_interface` with caller-selected
  `raw` or `hex` encoding. The owned worker deadline is `timeout_ms` (default
  30000 ms, range 1..2147483647, next call). Select byte, address-space and CPU
  allowances separately through `producer_limits`; tighter inherited OS limits
  remain enforced, and the 256 MiB worker heap is independent. Preserve
  carrier/decoded digests and treat selectors,
  argument strings and mutability as inferred candidates; this performs no chain
  lookup or target execution. For the complete inferred interface without hex or
  duplicate stdout, discover support and select `detail: "summary"`; complete
  Evidence stays retained under its original identity. Use the returned
  `parent_evidence_id` for exact function or `bytecode_hex`/stdout/stderr pages.
  Candidate coverage does not establish interface completeness. See the
  [EVM bytecode guide](https://github.com/morluto/rea/blob/main/docs/guides/evm/evm-bytecode.md).
- Embedded Go compiler, module, build-setting metadata, or static `(ptr, len)`
  string literals: `inspect_go_binary` with the explicit local file (pass
  `include_string_literals: true` and optional `max_string_literals` for bounded
  inferred static string-header recovery, and page retained rows with
  `inspect_analysis_view` kind `go` collection `string_literals`). This built-in
  target-free inspection requires no Go installation or disassembler. Preserve
  raw module bytes and source ranges; absent metadata does not prove a binary is
  not Go, static string recovery excludes compiler-inlined stack or immediate
  strings, and unparsed text records remain explicit. See the
  [Go binary guide](https://github.com/morluto/rea/blob/main/docs/guides/native/go-binaries.md).
- Embedded CUDA/HIP code objects: `inspect_gpu_code_objects`; inventory targets
  first, then decode selected payloads and query retained GPU Evidence.
- Bundled GGUF or safetensors model declarations: `inspect_model_artifact`
  with the explicit local file. Default header hashing leaves full-file identity
  unknown; `hash: "full"` additionally reads all weights for SHA-256. MCP returns
  retained summaries; optional `view` selects one page in the initial call. Use
  `inspect_analysis_view` kind `model-artifact` for
  batched metadata keys, tensor names or type totals, selected fields and pages.
  Preserve header-scoped indices and array preview omissions; do not infer model
  behavior from declared architecture or tensor types. See the
  [model file guide](https://github.com/morluto/rea/blob/main/docs/model-artifacts.md).
- Unity IL2CPP names, member owners and string literals from `global-metadata.dat`:
  `inspect_il2cpp_metadata` with the explicit local file; MCP defaults to compact
  counts. Query sections, images, types, methods, fields, properties, events,
  parameters or string_literals through `inspect_analysis_view`
  with the returned `parent_evidence_id`, using exact filters, batch indices and
  selected fields. Parameters accept `method_indices`, avoiding a scan of all
  parameter pages. Missing collections in historical Evidence remain unknown.
  Versions 24, 27, 29, 31 and 39; no Unity, IL2CPP
  binary or disassembler is run. Unrecognized magic (possibly encrypted) and
  other versions are unsupported. Optional matching `binary_path` enables static native addresses and type references; query `method_addresses` with indices or addresses/states, preserving every shared-body method and both artifact identities. Without a linked binary native counts remain unknown. Byte-pattern fallback is inferred; no runtime behavior or same-build pairing is proved. See the
  [IL2CPP metadata guide](https://github.com/morluto/rea/blob/main/docs/il2cpp-metadata.md).
- Embedded cargo-auditable Rust dependency metadata: `inspect_rust_binary`
  with the explicit local ELF, PE, or thin Mach-O file. This built-in
  target-free inspection requires no Rust installation or disassembler. Preserve
  package order, dependency indices, and the section file range. A missing
  `.dep-v0` section is null metadata, not proof the binary has no dependencies.
  A rustc commit hash is an inference from a read-only `/rustc/<40-hex>/` path.
  For selected crates, use `view: {collection: "packages", names: [...],
  fields: ["name", "version", "source"]}` on the first call; explicitly include
  `dependencies` for direct index references. Use `detail: "summary"` for counts
  and ranges, or retained `inspect_analysis_view` Rust package/edge pages for
  subsequent filters. Keep the complete parent Evidence accessible; CLI compact
  delivery requires `--evidence_output`.
  See the
  [Rust binary guide](https://github.com/morluto/rea/blob/main/docs/rust-binaries.md).
- CPython 3.7–3.15 `.pyc` header, nested marshal code objects and bytecode
  identity: `inspect_python_pyc` with the explicit local file. This built-in
  target-free inspection requires no Python installation. Preserve magic,
  PEP 552 hash or mtime/size, nested names, and bytecode SHA-256. Bytecode is
  not decompiled, and a decoded header does not prove the matching `.py` is
  present. See the
  [CPython pyc guide](https://github.com/morluto/rea/blob/main/docs/python-pyc.md).
- Erlang BEAM IFF container: `inspect_erlang_beam` with the explicit local
  `.beam` file. This built-in target-free inspection requires no Erlang
  installation. Preserve chunk names, atom order, export/import/lambda tables,
  and the Code header. For selected facts, prefer `detail: "summary"` plus a
  `beam` view (collection, names/indices, fields and paging), retaining the full
  Evidence. CLI summary requires `--evidence_output`. Missing table counts stay
  null; decoded empty tables count zero. Bytecode is not executed. See the
  [Erlang BEAM guide](https://github.com/morluto/rea/blob/main/docs/erlang-beam.md).

## Native file metadata (PE, ELF, Mach-O, kernel)

- PE Authenticode certificate table: `inspect_pe_certificates` with the explicit
  local PE32/PE32+ file. This built-in target-free inspection requires no
  Windows SDK. Preserve WIN_CERTIFICATE ranges, types, payload SHA-256, and
  PKCS#7 signer/X.509 identity fields, including `subject_key_identifier_hex`
  when the signer uses that form. A missing security directory is observed
  absence of that table, not proof the image is unsigned in every catalog sense.
  Signatures are not verified. See the
  [PE certificate guide](https://github.com/morluto/rea/blob/main/docs/pe-certificates.md).
- PE import and delay-load tables: `inspect_pe_imports` with the explicit
  local PE32/PE32+ file. This built-in target-free inspection requires no
  Windows SDK. Preserve DLL names, named and ordinal functions, ILT/IAT RVAs,
  delay-load descriptors, and the pefile import hash of the standard import
  table. A missing import directory is observed absence of that table, not
  proof the image never imported APIs through another table. Bound snapshots
  and loaded IAT contents remain unobserved. See the
  [PE import guide](https://github.com/morluto/rea/blob/main/docs/pe-imports.md).
- Windows Shell Link shortcuts: `inspect_windows_shortcut` with the explicit
  local `.lnk` file. This built-in target-free inspection requires no Windows
  SDK or COM. Preserve header flags and FILETIMEs, IDList items, LinkInfo
  volume and network names, StringData arguments and icon location, ExtraData
  signatures, and Tracker droid facts labelled derived. Unknown IDList items
  and ExtraData signatures stay raw with SHA-256. The target path is not
  resolved or executed. See the
  [Windows shortcut guide](https://github.com/morluto/rea/blob/main/docs/guides/native/windows-shortcut.md).
- PE TLS callbacks and load configuration: `inspect_pe_load_config` with the
  explicit local PE32/PE32+ file. This built-in target-free inspection requires
  no Windows SDK. Preserve callback VAs as strings with their RVA, file offset
  and section, and the size-covered security cookie, SafeSEH, CFG,
  EH-continuation and XFG fields. Guard-flag mitigation claims are inferred
  linker declarations, not proof of enforcement. A missing directory is observed
  absence of that declaration. See the
  [PE load configuration guide](https://github.com/morluto/rea/blob/main/docs/pe-load-config.md).
- ELF, PE, and Mach-O hardening: `inspect_binary_hardening` with the explicit
  local file. This built-in target-free inspection requires no pwntools or other
  host tool. One image per Mach-O slice. Each property is `enabled`, `disabled`,
  `partial`, `unknown`, or `not_applicable`, with the header field or import
  behind it. A missing stack-protector or fortify import is `unknown`, not
  proof the protection was omitted. Authenticode and Mach-O code signatures
  report presence, not validity. Hardened runtime stays unknown and names
  `inspect_signature`. The image is not executed. See the
  [binary hardening guide](https://github.com/morluto/rea/blob/main/docs/binary-hardening.md).
- ELF note tables: `inspect_elf_notes` with the explicit local ELF32/ELF64
  file. This built-in target-free inspection requires no disassembler. Preserve
  PT_NOTE and SHT_NOTE ranges, owners, types, descriptor SHA-256, and GNU
  build-id or ABI-tag fields. A missing table is observed absence of those
  declarations, not proof the image never carried notes. See the
  [ELF notes guide](https://github.com/morluto/rea/blob/main/docs/elf-notes.md).
- Code that runs before `main` or at exit in ELF or Mach-O:
  `inspect_native_initializers` with the explicit local file (and
  `architecture` for a universal Mach-O). This built-in inspection requires no
  disassembler. Preserve slot and target addresses, the `resolution` of each
  entry, and its limitations. An `unresolved` slot is not a zero pointer, and a
  missing table is not proof that no constructor exists. See the
  [initializer guide](https://github.com/morluto/rea/blob/main/docs/guides/native/native-initializers.md).
- ELF unwind function ranges: `inspect_elf_unwind_ranges` with the explicit
  local ELF32/ELF64 file. This built-in target-free inspection requires no
  disassembler. Preserve FDE start, end, size, containing section, exact
  symbol name, CIE index, LSDA, and personality. Page with `offset` and
  `limit`. A missing `.eh_frame` is observed absence of that declaration,
  not proof the image has no functions. `.debug_frame` is reported present
  or absent and is not decoded. CFA instructions are counted and not
  evaluated. See the
  [ELF unwind ranges guide](https://github.com/morluto/rea/blob/main/docs/guides/native/elf-unwind-ranges.md).
- Linux kernel module metadata: `inspect_kernel_module` with the explicit local
  ELF32/ELF64 relocatable file. This built-in target-free inspection requires
  no Linux host or `modinfo`. Preserve `.modinfo` key order and duplicate keys,
  `__versions` CRC hex, section file ranges, and the appended signature
  trailer's PKCS#7 SHA-256. A missing section is observed absence when section
  names are known, not proof the module never carried that metadata.
  `struct module` is not decoded. The signature is not validated. gzip, xz, and
  zstd containers are unsupported; decompress into a separate file with an
  external codec utility, then inspect the decompressed `ET_REL` image. See the
  [kernel module guide](https://github.com/morluto/rea/blob/main/docs/kernel-modules.md).
- Linux kernel version and build config (`CONFIG_*` options such as
  `CONFIG_SECURITY_SELINUX`): `inspect_kernel_build_config` with the explicit
  local `vmlinux`, raw `Image`, x86 `bzImage`, or `configs.ko`. This built-in
  target-free inspection requires no Linux host or `extract-ikconfig`. Preserve
  the banner version, config SHA-256, option count, and value kinds; use `name`
  for one option. An `IKCFG_ST` string is a config only with a valid gzip member
  and `IKCFG_ED`. An absent config may mean the kernel was built without
  `CONFIG_IKCONFIG`. Non-gzip payloads are unsupported; decompress externally,
  then inspect the result. See the
  [kernel build config guide](https://github.com/morluto/rea/blob/main/docs/guides/native/kernel-build-config.md).
- Explicit Linux ELF file for offline layout, symbols, relocations or static
  mitigation evidence: `inspect_binary_layout`. This target-free operation uses
  caller-supplied pwntools without opening a disassembler database. Preserve its
  raw locations and inference/coverage limits; see the
  [offline binary guide](https://github.com/morluto/rea/blob/main/docs/guides/native/binary-diagnostics.md).
- PE resource type/name/language trees and static icon group references:
  `inspect_pe_resources` with an explicit path. This portable operation requires
  no active target or engine; opaque payloads retain file ranges and SHA-256.
- PE export directories and ELF dynamic-symbol exports: `inspect_native_exports`
  with an explicit path; portable, no active target or engine.
- Native executable, library, or analysis database: `open_binary`, then
  use focused analysis tools directly; call `binary_overview` when metadata or
  inventory context is useful and available from the selected provider.

## Crash reports and databases

- Apple `.ips` crash reports: `inspect_apple_ips` with the explicit local
  file. This built-in target-free inspection requires no Xcode, atos, or
  pwntools. Preserve first-line metadata, `bug_type` as a string, process and
  exception facts, lossless integer registers, usedImages UUIDs, and
  documented classification matches. Only `bug_type` `"309"` yields a crash
  body; other types, including `"288"` stackshots, return no crash result.
  Select an optional `join_path` for UUID-and-architecture matching to one
  local Mach-O or dSYM; preserve slice identity and unjoined reasons. Joined
  static addresses do not resolve function names or dSYM symbols. See the
  [Apple IPS guide](https://github.com/morluto/rea/blob/main/docs/apple-ips.md).
- Explicit local SQLite database snapshot: `inspect_sqlite_database`. Inspect
  with Node.js 24.x >=24.15 or 26+ providing native SQLite limits. Read schema
  first (compact inventory by default), or select an exact ordinary table
  and `columns` when rows are needed. Defaults are selected-table schema and
  20 rows; request `schema_scope: "database"` for the complete stored schema. Preserve both database and existing sibling WAL identity; row samples
  report truncation and have unspecified order. Use a quiescent snapshot rather
  than assuming a live database/WAL pair was copied atomically. See the
  [SQLite guide](https://github.com/morluto/rea/blob/main/docs/guides/data/sqlite-databases.md).
- Supplied Linux x86-64 ELF core: `inspect_recorded_crash`. Read every recorded
  thread, raw note and source-bound register without opening a live target.
  Historical PIDs do not select live processes. Request `include_debugger_context`
  only when core-only mapping candidates help; see the
  [recorded crash guide](https://github.com/morluto/rea/blob/main/docs/guides/native/recorded-crashes.md).

## Target selection, native engines and sessions

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

If the user says only "my app" without a name, path, or target already selected
for this task, ask which app before searching for artifacts. Paths in unrelated
saved reports and nearby test fixtures do not select the user's target. Resolve
an actual human-readable app name to one clear installed artifact when possible;
ask when matches are ambiguous. Never choose an example app on the user's behalf.

In a target-free session, use `open_binary` to bind any archive/package or
native target whose analysis tool operates on the active target. Do not call an
unadvertised tool; inspect `binary_session` with `{}` and its
`result.tool_availability` for availability reasons and remediation. Expand each
group's `names` into entries, inheriting the inventory-level client requirements
unless the group overrides them. The grouped name union is the complete tool
inventory; use `tools/list` for canonical tool schemas. The default summary keeps
each provider candidate's availability and target-support status, code and
reason; `omitted_fields` lists what it leaves out. Request `{"detail": "complete"}`
only when you need an unavailable candidate's remediation, provider
diagnostics, candidate capability sets, or tool surface, effect and annotation
flags; in those closed flag vocabularies, listed
flags are true and omitted known flags are false. Provider candidate facts
describe possible providers, while top-level session capabilities describe the
current route and `analysis_provider_binding` names the selected provider. Do
not treat those scopes as interchangeable.

For editable Ghidra analysis that must survive a later agent process, select
the [owned Program checkpoint workflow](native-and-artifacts.md#continue-editable-ghidra-analysis-across-processes)
before making metadata edits. It is separate from Evidence/Unknown persistence.

For a Ghidra startup timeout on a large native target, follow
[deadline recovery](native-and-artifacts.md#ghidra-startup-deadline-recovery)
before abandoning deep analysis or repeating the same cold import. The default
330 seconds can be changed for new startup attempts through
`update_analysis_settings` using `ghidra.startup_timeout_ms`. Changing the
server's launch environment instead requires a new REA process.
