---
name: reverse-engineer-anything
description: Reverse engineer native, managed, Electron/JavaScript, packaged, firmware, and browser targets with REA, and build agent environments (AgentEnv bundles) of web applications from a live instance or a capture, and of Linux desktop apps with a task from a request. Use shipped-artifact or requested runtime evidence to explain features, compare versions, decompile code, or guide a reconstruction. Skip REA for ordinary source-repository architecture analysis.
metadata:
  version: "62"
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
assume work stopped. Read the recovery guide's deadline distinction before retrying.
If the MCP connection drops, retry that call once only when it is safe to
repeat or known not to have started. If it may already have changed the
target, or it fails again, tell the user and ask them to restart the MCP
client. If REA could not start its connection, retry once, then tell the user
and ask them to restart the MCP client. Do not retry a startup failure that
returns the same unchanged result. For plugin installs, follow
[plugin recovery](references/connection-and-recovery.md#rea-installed-as-a-client-plugin).
For setup-owned registrations, run `rea doctor` when REA could not start
or tools stay missing after that restart. For `cleanup_incomplete`, a retryable
capacity limit, or `configuration_invalid`, follow the recovery guide's ladder
before asking for a restart. Read that guide before a second repair attempt.

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
explicit path or endpoint and do not need it. **Before calling a tool below,
read its entry in [target routing](references/target-routing.md)**: it holds
the prerequisites (host tools, env vars), paging/view recipes, and the limits
on what each result proves.

| Target                                                                                        | First tool                                                                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| ASAR / extracted JavaScript or Electron tree                                                  | `analyze_javascript_application`                                                                    |
| Archive/package (ZIP, APK, IPA, MSIX/AppX, DMG, PyInstaller), Bun `--compile`, Deno `compile` | `open_binary`, then `inspect_artifact`                                                              |
| Apple plist, Interface Builder, asset catalog, keyed archive                                  | `open_bundle_resources`                                                                             |
| Android APK code/classes/methods                                                              | `inspect_android_package`; signing: `inspect_apk_signature`                                         |
| Managed PE/CLI assembly                                                                       | `inspect_managed_artifact`                                                                          |
| Firmware image / ESP32 image                                                                  | `inspect_firmware_regions`, `extract_firmware` / `inspect_artifact`                                 |
| Native runtime behavior, instrumentation                                                      | [runtime observation](references/runtime-observation.md#native-runtime-questions)                   |
| Open browser page / Electron runtime                                                          | `list_browser_targets` / `list_electron_targets` (check `inspect_electron_fuses` first)             |
| Browser actions or SPA traffic                                                                | `capture_browser_scenario` (pass API origins in `allowed_origins`)                                  |
| AgentEnv bundle (web) / desktop task / Linux desktop build                                    | [environments](references/environments.md), [desktop builds](references/desktop-build.md)           |
| HAR / SAZ / mitmproxy / qlog capture                                                          | `inspect_web_network_capture`                                                                       |
| Packet captures                                                                               | `inspect_packet_fields`, `inspect_packet_capture`, `inspect_pcap_capture`                           |
| Logic/signal recordings                                                                       | `inspect_signal_decoders`, `decode_signal_recording`                                                |
| WebAssembly / EVM bytecode                                                                    | `inspect_wasm_artifact` / `inspect_evm_interface`                                                   |
| Go / Rust / CPython `.pyc` / Erlang BEAM                                                      | `inspect_go_binary` / `inspect_rust_binary` / `inspect_python_pyc` / `inspect_erlang_beam`          |
| CUDA/HIP code, GGUF/safetensors, Unity IL2CPP                                                 | `inspect_gpu_code_objects` / `inspect_model_artifact` / `inspect_il2cpp_metadata`                   |
| PE certificates, imports, load config, resources                                              | `inspect_pe_certificates`, `inspect_pe_imports`, `inspect_pe_load_config`, `inspect_pe_resources`   |
| Exports, hardening, initializers                                                              | `inspect_native_exports`, `inspect_binary_hardening`, `inspect_native_initializers`                 |
| ELF notes, unwind ranges, layout, x86-64 core                                                 | `inspect_elf_notes`, `inspect_elf_unwind_ranges`, `inspect_binary_layout`, `inspect_recorded_crash` |
| Windows `.lnk`, Apple `.ips` crash                                                            | `inspect_windows_shortcut` / `inspect_apple_ips`                                                    |
| Kernel module / kernel config                                                                 | `inspect_kernel_module` / `inspect_kernel_build_config`                                             |
| SQLite snapshot                                                                               | `inspect_sqlite_database`                                                                           |
| Shipped-app exposure audit                                                                    | `audit_release_exposure`                                                                            |
| Native executable, library, analysis DB                                                       | `open_binary`, then focused tools (`binary_overview` when useful)                                   |

Rules that always apply:

- If the user says only "my app" with no name, path, or selected target, ask
  which app. Never pick an example app or a path from unrelated reports/fixtures.
- Do not call an unadvertised tool; check `binary_session` `{}` and its
  `result.tool_availability` for availability and remediation.
- IDA (`provider_id: "ida"`, pass the original binary, not `.idb`/`.i64`), Kuna
  (`REA_KUNA_COMMAND`), Ghidra checkpoints and Ghidra startup timeouts: see
  [target selection and engines](references/target-routing.md#target-selection-native-engines-and-sessions).

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
- Per-target routing details, prerequisites and limits:
  [references/target-routing.md](references/target-routing.md)
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
