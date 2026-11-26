---
name: reverse-engineer-anything
description: Reverse engineer native, managed, Electron/JavaScript, packaged, firmware, and browser targets with REA, and build agent environments (AgentEnv bundles) of web applications from a live instance or a capture, and of Linux desktop apps with a task from a request. Use shipped-artifact or requested runtime evidence to explain features, compare versions, decompile code, or guide a reconstruction. Skip REA for ordinary source-repository architecture analysis.
metadata:
  version: "63"
---

# REA

Use REA when a claim depends on a shipped binary or package, decompilation,
requested runtime evidence, or comparison with
behavior not established by available source. For ordinary analysis of a
complete source repository, use normal repository tools and do not run REA
readiness or provider commands.

## Connect only when needed

Installing this skill supplies instructions; it does not register the REA MCP
server, install analysis engines, or add tools to an already-running agent.
The exception is a Claude Code, Codex, or Cursor Marketplace plugin install:
the plugin bundles this skill and registers its own `rea` server, outside the
state that `rea setup` and `rea doctor` manage.

If REA tools are available and their registration is not known to be stale,
proceed directly to the target. Do not run diagnostics or setup before every
investigation. Use the connected server's actual tool list and input schemas;
a skill installed from repository main may describe capabilities absent from
an older npm release. Keep complete inline Evidence when that server does not
advertise retained references.

If tools are absent, a call is blocked by the client, or a required provider is
unavailable, read [connection and recovery](references/connection-and-recovery.md).
Diagnose the observed blocker, continue useful supported work, and resume the
original task after repair. Client approval, shell PATH, registration and engine
availability have different remedies; avoid repeating setup for all of them.
If the host times out without a REA result, do not repeat the unchanged call or
assume work stopped; read the guide's
[deadline distinction](references/connection-and-recovery.md#distinguish-client-and-server-deadlines).
When the MCP connection drops, REA could not start, or a call returns
`cleanup_incomplete`, a retryable capacity limit or `configuration_invalid`,
follow its [recovery ladder](references/connection-and-recovery.md#recovery-ladder)
before retrying, restarting or repairing.

Choose the installation owner before repairing registration. Plugin installs use
[plugin recovery](references/connection-and-recovery.md#rea-installed-as-a-client-plugin);
only setup-owned registrations use the guide's
[registration repair plan](references/connection-and-recovery.md#repair-registration-when-needed).
A plugin-only doctor result of `missing` does not call for `rea setup`.

REA setup never installs or upgrades Node.js, npm, Homebrew, Java, Ghidra, IDA,
JADX, Kuna, Binwalk, or Unblob. Use existing prerequisites; do not install unrelated
software to repair MCP registration. For an unsupported client, use manual stdio
registration with an existing installation’s absolute runtime and entry script, or continue through the CLI.

A concrete CLI fallback for an operator-supplied JavaScript tree or ASAR is:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

No MCP registration or native engine is required. Read the returned Evidence,
graph, limitations, and unknowns with the same care as an MCP result; the CLI
returns the Evidence record directly. This fallback does not establish that
MCP is configured. Native CLI tasks still require their selected engine.
Prefer an existing `rea` CLI. When none is installed and REA package acquisition
is within the authorized scope, use `npx -y rea-agents@latest` in its place from a
trusted directory outside the target project, with absolute target paths. Managed
setup binds the current installation directly; retain its runtime and package
cache entry, or restore that installation before repairing its registration.
For setup-owned registration, configuration repair starts with a read-only setup plan; show paths, backups and
skill replacement before applying authorized changes. Preserve existing approval
and target-execution boundaries.

## Route the target first

Choose the first tool from the target the user supplied. Use `open_binary` for
active-target native or archive workflows; target-free tools take their own
explicit path or endpoint and do not need it.

- ASAR or extracted JavaScript/Electron tree:
  `analyze_javascript_application`. To find a few files in a packaged
  `app.asar`, open it with `open_binary`, start with `inspect_artifact`
  using `detail: "summary"`, then analyze the selected files with
  `source_paths`. When you intend to retain digest contradictions from
  re-signed unpacked companions, pass `integrity_policy: "record-and-continue"`
  starting with `inspect_artifact`. See the
  [JavaScript applications reference](references/javascript-applications.md).
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
- UEFI firmware volumes and NVAR stores: use bundled `inspect_artifact`.
  For external firmware scanning or extraction on Linux, use
  `inspect_firmware_regions` or `extract_firmware` with caller-supplied
  Binwalk or Unblob. Extraction needs a caller-selected new absolute output
  directory. See the [firmware guide](https://github.com/morluto/rea/blob/main/docs/guides/firmware/firmware-analysis.md).
- ESP32-family app or bootloader image (`0xE9` magic): `inspect_artifact`
  without a provider; see the ESP section of `references/native-and-artifacts.md`.
- .NET NativeAOT PE/ELF: native Ghidra analysis. Native code can yield pseudocode;
  consult the NativeAOT workflow in `references/native-and-artifacts.md` for
  optional metadata recovery and its supported host/layout boundary.
- Native program behavior, live calls, instrumentation, or command-run effects:
  choose the matching [native runtime workflow](references/runtime-observation.md#native-runtime-questions).
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
  [runtime observation](references/runtime-observation.md) for connect/launch
  and the focused follow-up browser tools.
- Agent environment (AgentEnv bundle) of a web application: read
  [environments](references/environments.md) before recording; it records with
  `capture_browser_scenario` and writes the bundle with `export_environment_bundle`.
- Task for a desktop application's exported environment, from a
  `capture-desktop-application` folder: read
  [desktop application tasks](references/environments.md#tasks-for-a-desktop-application-environment).
- Environment of a Linux desktop app with a task, from a request such as
  "build me an Inkscape environment where the agent changes a poster's
  headline": read [desktop builds](references/desktop-build.md). You drive the
  app on a build computer from `start_build_computer`, then export and witness.
- Fiddler Everywhere traffic or a native `.saz` capture: read the
  [Fiddler workflow](references/runtime-observation.md#fiddler-everywhere-traffic-debugging).
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
- User-owned Electron runtime already open: `list_electron_targets`. Before an electron-main Inspector attempt, check packaged fuses with `inspect_electron_fuses`; disabled `EnableNodeCliInspectArguments` means the app ignores `--inspect`.
- Shipped application exposure for a local `.app`, install directory, ASAR, or executable: `audit_release_exposure` / `rea audit-release-exposure`. Each check has a stable id, a status, and fixed remediation. Unknown and unassessed checks stay in the report. This does not establish that an application is secure. Credential-marker hits report the rule id and location only. See [release exposure](https://github.com/morluto/rea/blob/main/docs/release-exposure.md).
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
- Explicit local file in a format with a dedicated target-free tool: call that
  tool with the file path. These tools need no active target or disassembler
  unless their description names a caller-supplied host tool. Their descriptions
  state supported layouts, defaults, paging and limits; the linked guides give
  the workflow. Prefer `detail: "summary"` with retained `inspect_analysis_view`
  pages when the tool offers them and the inventory is large. A missing table or
  section is observed absence of that declaration in this file, not proof the
  behavior or metadata never existed.
  - WebAssembly: `inspect_wasm_artifact` with WABT through
    `REA_WABT_BIN_DIRECTORY`; select JavaScript glue and candidate paths
    explicitly ([WASM guide](https://github.com/morluto/rea/blob/main/docs/guides/wasm/wasm-artifacts.md)).
  - APK, ZIP or AAB signing: `inspect_apk_signature`, identity and integrity
    rather than a trust verdict ([APK signature guide](https://github.com/morluto/rea/blob/main/docs/apk-signature.md)).
  - EVM bytecode: `inspect_evm_interface`; selectors, arguments and mutability
    are inferred candidates ([EVM bytecode guide](https://github.com/morluto/rea/blob/main/docs/guides/evm/evm-bytecode.md)).
  - Go build metadata or static `(ptr, len)` strings: `inspect_go_binary`
    ([Go binary guide](https://github.com/morluto/rea/blob/main/docs/guides/native/go-binaries.md)).
  - Rust cargo-auditable dependencies: `inspect_rust_binary`; for selected
    crates, pass a `packages` `view` on the first call
    ([Rust binary guide](https://github.com/morluto/rea/blob/main/docs/rust-binaries.md)).
  - Embedded CUDA/HIP code objects: `inspect_gpu_code_objects`; inventory
    targets first, then decode selected payloads.
  - GGUF or safetensors declarations: `inspect_model_artifact`; do not infer
    model behavior from declared architecture or tensor types
    ([model file guide](https://github.com/morluto/rea/blob/main/docs/model-artifacts.md)).
  - Unity IL2CPP `global-metadata.dat`: `inspect_il2cpp_metadata`; pass the
    matching native binary as `binary_path` to link method addresses
    ([IL2CPP metadata guide](https://github.com/morluto/rea/blob/main/docs/il2cpp-metadata.md)).
  - Maven `pom.xml` or Gradle `.module`: `inspect_maven_gradle_metadata`
    ([Maven and Gradle guide](https://github.com/morluto/rea/blob/main/docs/maven-gradle-metadata.md)).
  - PE tables: `inspect_pe_certificates`, `inspect_pe_imports`,
    `inspect_pe_load_config` and `inspect_pe_resources`; PE or ELF exports:
    `inspect_native_exports`. Signatures are not verified
    ([certificates](https://github.com/morluto/rea/blob/main/docs/pe-certificates.md),
    [imports](https://github.com/morluto/rea/blob/main/docs/pe-imports.md),
    [load configuration](https://github.com/morluto/rea/blob/main/docs/pe-load-config.md)).
  - Windows `.lnk` shortcut: `inspect_windows_shortcut`; the target is not
    resolved ([shortcut guide](https://github.com/morluto/rea/blob/main/docs/guides/native/windows-shortcut.md)).
  - ELF, PE and Mach-O hardening: `inspect_binary_hardening`; use
    `inspect_signature` for Mach-O hardened runtime
    ([hardening guide](https://github.com/morluto/rea/blob/main/docs/binary-hardening.md)).
  - ELF declarations: `inspect_elf_notes`, `inspect_elf_debug_link` (pass
    `candidate_path` only for a debug file you already selected),
    `inspect_elf_dependencies` and `inspect_elf_unwind_ranges`. Relocatable
    objects use `inspect_kernel_module`; core dumps use
    `inspect_recorded_crash`
    ([notes](https://github.com/morluto/rea/blob/main/docs/elf-notes.md),
    [debug files](https://github.com/morluto/rea/blob/main/docs/guides/native/elf-debug-link.md),
    [dependencies](https://github.com/morluto/rea/blob/main/docs/elf-dependencies.md),
    [unwind ranges](https://github.com/morluto/rea/blob/main/docs/guides/native/elf-unwind-ranges.md)).
  - DWARF compile units, including the DWARF file inside a `.dSYM`:
    `inspect_dwarf_units` ([DWARF guide](https://github.com/morluto/rea/blob/main/docs/guides/native/dwarf-units.md)).
  - Code that runs before `main` or at exit in ELF or Mach-O:
    `inspect_native_initializers`
    ([initializer guide](https://github.com/morluto/rea/blob/main/docs/guides/native/native-initializers.md)).
  - Apple `.ips` crash report: `inspect_apple_ips`; `join_path` matches one
    local Mach-O or dSYM ([Apple IPS guide](https://github.com/morluto/rea/blob/main/docs/apple-ips.md)).
  - Linux kernel module: `inspect_kernel_module`; kernel version and
    `CONFIG_*` options: `inspect_kernel_build_config`. Decompress unsupported
    containers into a separate file with an external codec, then inspect the
    result ([kernel modules](https://github.com/morluto/rea/blob/main/docs/kernel-modules.md),
    [kernel build config](https://github.com/morluto/rea/blob/main/docs/guides/native/kernel-build-config.md)).
  - CPython `.pyc`: `inspect_python_pyc`; Erlang `.beam`:
    `inspect_erlang_beam`; NuGet `.nupkg`: `inspect_nuget_nupkg`
    ([pyc](https://github.com/morluto/rea/blob/main/docs/python-pyc.md),
    [BEAM](https://github.com/morluto/rea/blob/main/docs/erlang-beam.md),
    [NuGet](https://github.com/morluto/rea/blob/main/docs/guides/managed/nuget-nupkg.md)).
  - SQLite snapshot: `inspect_sqlite_database`; read the schema first and
    supply a quiescent snapshot rather than a live database/WAL pair
    ([SQLite guide](https://github.com/morluto/rea/blob/main/docs/guides/data/sqlite-databases.md)).
  - Linux ELF layout, symbols, relocations or static mitigations:
    `inspect_binary_layout` with caller-supplied pwntools
    ([offline binary guide](https://github.com/morluto/rea/blob/main/docs/guides/native/binary-diagnostics.md)).
  - Linux ELF core: `inspect_recorded_crash`; historical PIDs do not select
    live processes. Request `include_debugger_context` only when core-only
    mapping candidates help
    ([recorded crash guide](https://github.com/morluto/rea/blob/main/docs/guides/native/recorded-crashes.md)).
- Native executable, library, or analysis database: `open_binary`, then
  use focused analysis tools directly; call `binary_overview` when metadata or
  inventory context is useful and available from the selected provider. If
  automatic selection returns `capability_unavailable` with
  `selection_reason: "ambiguous"`, several providers are usable for the
  selected target. Choose one of the reported candidates and retry with its
  `provider_id`. Without an active target, `binary_session({})` shows host
  availability and leaves target support unknown.

For an existing IDA MCP configuration, use `open_binary` with the original
input binary and `provider_id: "ida"`. Only the Hex-Rays (`hexrays`) profile
also admits an existing `.idb` or `.i64`: pass the database path to start from
its saved annotations instead of a fresh auto-analysis. REA analyzes a private
copy and never writes the selected database.
The native attached profile binds the already-open GUI input by SHA-256 and
leaves its database open. The modern headless profile creates and closes an
owned private database without saving; it reuses
[mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp). See the
[IDA provider guide](https://github.com/morluto/rea/blob/main/docs/providers/ida-provider.md).
A registration naming the removed ida-pro-mcp 1.4 `"legacy"` protocol is
refused; follow the guide's
[legacy attached migration](https://github.com/morluto/rea/blob/main/docs/providers/ida-provider.md#migrate-a-legacy-attached-registration)
instead of editing the protocol value. No IDA profile provides direct callers;
check session availability and the guide's verification limits.
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
the [owned Program checkpoint workflow](references/native-and-artifacts.md#continue-editable-ghidra-analysis-across-processes)
before making metadata edits. It is separate from Evidence/Unknown persistence.

For a Ghidra startup timeout on a large native target, follow
[deadline recovery](references/native-and-artifacts.md#ghidra-startup-deadline-recovery)
before abandoning deep analysis or repeating the same cold import. The default
330 seconds can be changed for new startup attempts through
`update_analysis_settings` using `ghidra.startup_timeout_ms`. Changing the
server's launch environment instead requires a new REA process.

## Work summary-first

Start with the default result and use its inline Evidence and graph context.
For a JavaScript application or ELF layout whose size is unknown or large,
call `analyze_javascript_application` or `inspect_binary_layout` with
`"detail": "summary"`, then inspect the retained `parent_evidence_id` with
`inspect_analysis_view`. Over MCP, `analyze_function` is summary-first without
a flag: its default reply is the summary, and the complete dossier stays
retained under `parent_evidence_id` for facet paging. Pass that ID as a
`retained-evidence` reference to `compare_functions`, or inside
`match_native_functions` `left_observations`/`right_observations` or
`build_call_path.functions`; request `"detail": "complete"` only when the
dossier must travel inline.
Use the same exact-reference form in other advertised logical Evidence inputs,
including optional sources, arrays and nested sources across domains. Each
source can independently be inline or retained; preserve its source identity,
coverage, partial facts and unknowns. A summary or inspection page has its own
Evidence ID: use `normalized_result.parent_evidence_id` when the consumer needs
the complete source. For portable CLI follow-ups, commands advertising
`--evidence-bundle` resolve references from that selected exported bundle.
See [Evidence composition](references/evidence-workflows.md) for scope and
recovery; file selectors are supported only where explicitly advertised.
Page module identities and select the returned `node_id` before requesting an
item; a single file path can represent several graph roles. Do not repeat an
identical analysis or rejected call without a changed input or resolved blocker.
Recheck session state when a lifecycle change makes that status useful.
Make a focused follow-up only when the
returned result leaves a specific question unanswered.

If MCP reports `resource_constraint` with `details.resource: "transport"`, call
`inspect_analysis_view` with its reported same-session Evidence reference for a
summary, one section/module, or a stable page. Use `trace_application_feature`
once a seed is known, or call `export_evidence_bundle` to write the complete
session to a selected path. The analysis remains complete in the ledger; avoid
repeating it merely to request the same oversized response. Complete CLI JSON
output also streams without a single MCP frame.

When the retained parent ID is unknown, use `get_evidence_bundle` with
`detail: "summary"` and exact filters for operation, target SHA-256,
analysis-profile digest or canonical procedure address. Select its returned
Evidence ID for the next view instead of requesting the complete bundle. When
that record has no supported view (for example an annotation), read it with
`detail: "records"` and an `evidence_id` filter; `missing_evidence_links`
names linked sources this session does not retain.
`retention: "complete-record"` means the whole record is stored; native
value-flow truncation and unknown metadata remain separate. For an exported
portable bundle, use `rea inspect-evidence-bundle` with JSON containing `path`,
`detail: "summary"` and the same `filters`. Reading that file still requires
validating its full contents within the local memory budget.

A client can also truncate a successful tool result without a REA transport
error. Treat that preview as incomplete; use the retained parent ID for smaller
views or export when the full record is needed. Do not parse the preview as
canonical JSON or repeat the producer. For JavaScript, read the
[module-view and trace recipes](references/javascript-applications.md) before
drilling into a large graph; a broad bidirectional trace can expand unrelated
containment relationships even after summary analysis.

Every conclusion must distinguish observations, inferences, and unknowns. Cite
Evidence IDs, preserve limitations and incomplete coverage, and never imply
that static analysis observed execution. Runtime requests execute the declared
target and lifecycle; do not broaden the target or action beyond those fields.

Within the user's requested investigation, call available analysis tools
directly. REA does not require permission grants or per-call approval flags.
The agent client can independently require approval. Follow the declared request
scope and the host's actual access requirements; use the recovery guide for an
observed client-policy rejection.

## Plan broader investigations

For requests that span multiple features or subsystems, use a staged workflow:

1. Turn the request into a checklist of questions and the evidence each answer
   needs. Resolve target identity and constraints from the conversation and
   workspace before asking for information again.
2. Inspect the current REA session, artifact identity, saved analysis database,
   bookmarks, and prior evidence. Reuse matching state; do not open duplicate
   sessions or repeat identical analysis.
3. Start with the smallest useful overview or inventory. Follow each question
   from its entry point through relevant data and state changes to its result.
   Batch related operations around a specific hypothesis, then expand only when
   the returned evidence leaves a concrete gap.
4. Inspect relevant packaged resources and configuration alongside code when
   they affect the question. Use format-aware inventory and parsers; do not
   infer behavior from filenames, strings, or layout alone.
5. Corroborate a conclusion with the evidence type it requires. Use runtime
   observation only when static evidence cannot answer the question and the
   required host runtime and OS access are available. For JavaScript behavior,
   run probes against the actual app through the available browser, Electron,
   or process capture workflow.
6. Decompose work into independent questions. When parallel workers are
   available and the questions do not depend on one another, assign distinct
   scopes, point workers to existing evidence, and ask them to return sources,
   conclusions, and unresolved gaps. Otherwise, work sequentially.
7. Keep a concise finding ledger linking each conclusion to Evidence IDs,
   confidence/evidence type, search boundary, and remaining unknowns. Update
   the shared index or investigation report so later passes can reuse results.

Before finishing, revisit the original checklist. Mark each question as
answered, partially answered, or unresolved based on its evidence; keep
bounded negative searches bounded, and do not describe a broad investigation
as complete while required questions remain open.

## Read only the relevant guide

- Native binaries, managed assemblies, archives, and extraction:
  [references/native-and-artifacts.md](references/native-and-artifacts.md)
- ASARs, extracted JavaScript, feature tracing, and version comparison:
  [references/javascript-applications.md](references/javascript-applications.md)
- Android APK declarations, classes, methods, and static references:
  [references/android-applications.md](references/android-applications.md)
- Native instrumentation, debugger and process capture; browser/Electron
  observation; static/runtime comparison:
  [references/runtime-observation.md](references/runtime-observation.md)
- Evidence paging, comparisons, residual unknowns, and verification:
  [references/evidence-workflows.md](references/evidence-workflows.md)
- Agent environments (AgentEnv bundles) of a web application, recorded from
  a live instance or a HAR:
  [references/environments.md](references/environments.md)
- Tasks for a desktop application's exported environment:
  [references/environments.md](references/environments.md#tasks-for-a-desktop-application-environment)
- A desktop app environment from a request, built and witnessed on build
  computers: [references/desktop-build.md](references/desktop-build.md)

## Finish the task

Explain findings in plain language and tie them to returned evidence. When the
user asks to build something, use normal coding tools and separate observed
behavior from design choices. Close an opened native session with
`close_binary` when its engine is no longer needed. Evidence references and Unknown
history remain in memory on the same MCP connection. End the investigation with
`reset_investigation`; supply `save_path` to checkpoint the complete bundle before
clearing. Import the saved bundle to restore original references and Unknown
history in a new process. Retention is bounded and is not automatic persistence.
