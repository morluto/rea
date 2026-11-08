---
name: reverse-engineer-anything
description: Reverse engineer native, managed, Electron/JavaScript, packaged, firmware, and browser targets with REA, and build agent environments (AgentEnv bundles) of web applications from a live instance or a capture. Use shipped-artifact or requested runtime evidence to explain features, compare versions, decompile code, or guide a reconstruction. Skip REA for ordinary source-repository architecture analysis.
metadata:
  version: "62"
---

# REA

Use REA when a claim depends on a shipped artifact, decompilation, requested
runtime evidence, or behavior not established by available source. For ordinary
analysis of a complete source repository, use normal repository tools and do not run REA
readiness or provider commands.

## Select the target and authority

Use the target selected for this task. If the user says only "my app", ask which
app before searching artifacts. Resolve a named app to one clear installed
artifact; ask when ambiguous. Unrelated reports and nearby fixtures do not select
it. Never substitute an example or broaden the selected target or runtime actions.

Distinguish observations, derivations, inferences, and unknowns. Cite Evidence
IDs and preserve source identity, coverage, limitations and partial facts.
Static code, strings and declarations do not establish observed execution.
Within the requested investigation, call available analysis tools directly;
REA requires no permission grants or per-call approval flags. The client may
independently require approval; preserve its actual access requirements.

## Connect only when needed

If REA tools are available and registration is not known stale, proceed directly.
Use the connected server's actual tool list and schemas: repository-main guidance
may describe features absent from an older release. Keep complete inline Evidence
when retained references are not advertised. Skill installation alone adds no
MCP server or engines; a Claude Code/Codex plugin bundles its own server.

For absent tools, blocked calls, unavailable providers, host timeouts or startup
failures, read [connection and recovery](references/connection-and-recovery.md)
before repair. Diagnose the observed blocker, continue useful supported work,
and resume the original task after repair. Do not repeat unchanged failed calls.
A host timeout without a REA result does not establish cancellation or cleanup.
Retry a dropped connection once only if safe to repeat or known not started;
if it may have changed the target, or fails again, ask for a client restart.
Retry failed connection startup once; do not retry the same unchanged failure.

Choose the registration owner: plugin recovery differs from setup-owned repair.
A plugin-only doctor result of `missing` does not call for `rea setup`.
Setup-owned repair starts with a read-only plan showing paths, backups and skill
replacement before authorized writes. Do not install unrelated software to repair
registration. REA setup never installs/upgrades Node, npm, Homebrew, Java,
Ghidra, IDA, JADX, Kuna, Binwalk or Unblob.
For an unsupported client, use manual stdio with an existing absolute runtime
and entry script, or the CLI fallback in the recovery guide.

## Route before analysis

Read the matching guide before its workflow; read only the relevant sections.
Target-free tools take their explicit paths/endpoints without `open_binary`.
Active-target native/archive tools require it. Archive members and executable
code are different questions; follow the selected artifact's application layer.

| Supplied target or question                                                                                                      | Guide and first operation                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native executable/library, Ghidra/IDA/Kuna, managed PE/CLI or NativeAOT                                                          | [Native and managed](references/native-and-artifacts.md): `open_binary`; managed CLI metadata: `inspect_managed_artifact`. Read provider/lifecycle sections before reuse or edits.                                                                 |
| Headerless/raw firmware, Cortex-M, ESP app/bootloader or whole-flash dump, HEX/S-record/UF2/DfuSe                                | [Firmware and raw images](references/firmware-and-raw-images.md): check loader support first; raw: explicit `open_binary` format/mapping; ESP/container: `open_binary` then `inspect_artifact`; region scan/extraction: advertised firmware tools. |
| Archive/package inventory or extraction, PyInstaller, Bun executable, Godot PCK, UnityFS or wxapkg                               | [Packages and archives](references/packages-and-archives.md): `open_binary`, then `inspect_artifact`; read extraction/mount limits before materializing.                                                                                           |
| ASAR/extracted JavaScript or Electron tree, feature trace or version comparison                                                  | [JavaScript applications](references/javascript-applications.md): `analyze_javascript_application`.                                                                                                                                                |
| APK code, manifest, classes, methods or incoming references                                                                      | [Android applications](references/android-applications.md): `inspect_android_package`; signing/inventory use their separate routes.                                                                                                                |
| PE/ELF/Mach-O tables or hardening, Go/Rust/IL2CPP/GPU/model metadata, pyc/BEAM, SQLite, WASM, EVM, APK signing or recorded crash | [Offline format inspectors](references/format-inspectors.md): select the named target-free inspector in that format's section.                                                                                                                     |
| Apple plist, Interface Builder, asset catalog or keyed archive resources; unknown desktop installation directory                 | [Resource and directory inspection](references/native-and-artifacts.md#apple-app-resources): `open_bundle_resources` or `inspect_desktop_application`; no executable/provider required for resource sessions.                                      |
| Native execution, live calls, instrumentation, process effects; browser/Electron runtime or agent-performed actions              | [Runtime observation](references/runtime-observation.md): select the observation and declared lifecycle first. Already-open page: `list_browser_targets`; Electron: `list_electron_targets`; agent actions: `capture_browser_scenario`.            |
| Recorded HAR/SAZ/mitmproxy/qlog, packet capture, protocol-field discovery or logic/signal recording                              | [Recorded captures](references/recorded-captures.md): `inspect_web_network_capture`, packet/signal inspection or decoder discovery as appropriate; no live acquisition or recorded-URL fetch.                                                      |
| Web AgentEnv bundle from a live instance or capture; task for an exported desktop environment                                    | [Environments](references/environments.md), including its desktop-task section: read before recording/export; `capture_browser_scenario` then `export_environment_bundle` for a live web bundle.                                                   |
| Retained Evidence paging/composition, comparisons, unknowns or a broader investigation                                           | [Evidence workflows](references/evidence-workflows.md): use existing source IDs and the smallest view that answers the question.                                                                                                                   |

If a needed tool is unadvertised, inspect `binary_session {}` and
`result.tool_availability` for availability reasons/remediation; never call an
unadvertised tool. Expand group `names`, inheriting inventory client requirements
unless overridden. Their union is the complete in-scope inventory; `tools/list`
owns canonical schemas. The default summary keeps provider candidate status,
code and reason; `omitted_fields` names exclusions. Request `detail: "complete"`
only for remediation/diagnostics, candidate capabilities or tool effect flags.
Candidate facts describe possible providers; top-level capabilities and
`analysis_provider_binding` describe the current route. Keep those scopes distinct.

## Work summary-first

Start with inline Evidence and graph context. For unknown/large JavaScript or ELF
layout, select advertised `detail: "summary"`; MCP `analyze_function` already
defaults to a summary. Small complete results can cost less than extra pages.
Make a focused follow-up only for a specific unanswered question. Reuse matching
session state and Evidence instead of repeating analysis; recheck state when a
lifecycle change makes it useful.

Complete source Evidence stays accessible through advertised retained references.
A summary/page has its own Evidence ID; use `normalized_result.parent_evidence_id`
when a consumer needs the complete source. Pass `{kind: "retained-evidence",
evidence_id}` in inputs advertising that form; do not resend complete records.
Sources may independently be inline or retained. Read the Evidence guide for
exact filters, bundle-based CLI reuse, comparison roles and missing-source recovery.

For REA transport refusal or client-truncated output, inspect a smaller retained
view or export complete Evidence. Do not parse a preview as canonical JSON or
repeat the producer. Never invent an Evidence ID; if unknown, find it with
`get_evidence_bundle` summary filters. Retention is bounded and session-local;
it does not establish automatic persistence or complete source coverage.

For broad investigations, read the Evidence guide's staged workflow. Track the
questions, source boundaries and unresolved gaps; do not claim completion while
required questions remain open. Inspect packaged resources alongside code when
relevant, and use runtime evidence only within the requested scope.

## Finish the task

Explain findings in plain language and tie them to returned Evidence. For builds,
use normal coding tools and separate observed behavior from design choices.
Close an opened native/resource session with `close_binary` when no longer needed.
Evidence references and Unknown history remain on the same MCP connection.
End with `reset_investigation`; use `save_path` to checkpoint the complete bundle
before clearing. Import that bundle, including its source closure, to restore
original references and Unknown history in a new process. Editable Ghidra Program
checkpoints are separate; read that workflow before edits needing persistence.
