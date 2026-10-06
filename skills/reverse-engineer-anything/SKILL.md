---
name: reverse-engineer-anything
description: Reverse engineer native, managed, Electron/JavaScript, packaged, and browser applications with REA. Use shipped-artifact or requested runtime evidence to explain features, compare versions, decompile code, or guide a reconstruction. Skip REA for ordinary source-repository architecture analysis.
metadata:
  version: "24"
  tool_count: 118
  catalog_digest: "8778381e23b001485ddab201a9a41bdc3c2a0631ccadb1afa83371f6c2fcbe6c"
---

# REA

Use REA when a claim depends on a shipped binary or package, decompilation,
passive application runtime evidence, or comparison with
behavior not established by available source. For ordinary analysis of a
complete source repository, use normal repository tools and do not run REA
readiness or provider commands.

## Route the target first

Choose the first tool from the target the user supplied. Do not call
`open_binary` unless the target is native or an analysis database.

- ASAR or extracted JavaScript/Electron tree:
  `analyze_javascript_application`.
- Archive, application package, ZIP/APK/IPA/MSIX/AppX, or DMG:
  `open_binary` with the supplied local path; use `inspect_artifact` when its
  graph and findings help answer the question.
- Managed PE/CLI assembly: `inspect_managed_artifact`.
- User-owned browser page already open: `list_browser_targets`.
- User-owned Electron runtime already open: `list_electron_targets`.
- Native executable, library, or analysis database: `open_binary`, then
  use focused analysis tools directly; call `binary_overview` when metadata or
  inventory context is useful.

If the app is missing, ask which app to inspect. Resolve a human-readable app
name to one clear installed artifact when possible; ask only when matches are
ambiguous. Never choose an example app on the user's behalf.

In a target-free session, use `open_binary` to bind any archive/package or
native target whose analysis tool operates on the active target. Do not call a
tool hidden from `tools/list`; inspect `binary_session` with
`detail: "capabilities"` for the exact remediation when a desired capability
is unavailable.

## Work summary-first

Start with the default result and use its inline Evidence and graph context.
Do not repeat an identical tool call. Make a focused follow-up only when the
returned result leaves a specific question unanswered.

Every conclusion must distinguish observations, inferences, and unknowns. Cite
Evidence IDs, preserve limitations and incomplete coverage, and never imply
that static analysis observed execution. Runtime requests execute the declared
target and lifecycle; do not broaden the target or action beyond those fields.

Within the user's requested investigation, call available analysis tools
directly. REA does not require permission grants or per-call approval flags.
Follow the declared request scope and the host's actual access requirements.

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
- Passive browser/Electron observation and static/runtime reconciliation:
  [references/runtime-observation.md](references/runtime-observation.md)
- Evidence paging, comparisons, residual unknowns, and verification:
  [references/evidence-workflows.md](references/evidence-workflows.md)

## Readiness and setup

The readiness rule is conditional: when REA tools are available and their
registration is not known to be stale, proceed directly; do not run `doctor`
before every task. Run `npx -y rea-agents@latest doctor` when the MCP server or
required provider is unavailable, registration is reported stale, or the user
asks for an environment diagnosis. Propose
`npx -y rea-agents@latest setup` only when doctor identifies an alignment or
provider problem. Show the exact plan and obtain approval before setup writes
configuration or installs Hopper. Restart the agent after MCP registration
changes; direct CLI commands remain available immediately.

## Finish the task

Explain findings in plain language and tie them to returned evidence. When the
user asks to build something, use normal coding tools and separate observed
behavior from design choices. Close an opened native session with
`close_binary` when the investigation is complete.
