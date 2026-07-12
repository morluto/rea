---
name: rea-analysis
description: Reverse engineer apps with REA. Explore how features work, then build a version tailored to your project.
metadata:
  version: "10"
  tool_count: 68
---

# REA

Use REA when the user wants to understand how an app or feature works, compare app versions, decompile code, or build a similar feature.

## Understand the request

Identify the app and what the user wants to understand or build. Do not ask for information they already provided.

If the app is missing, ask which app they want to reverse engineer. If the app is known but the goal is unclear, ask what they want to understand or build, and offer to start with an overview. Never require the user to supply a program path, address, architecture, or reverse-engineering terminology.

Notes is only a documentation example. Never select an app unless the user names it or confirms it.

## Ensure REA is ready

1. Run `npx -y rea-agents doctor`.
2. If setup is needed, tell the user REA needs to install its local binary-analysis tools. Do not lead with implementation details or assume the user knows reverse-engineering products.
3. Before installing external software, obtain approval and identify what will be installed. If deeper analysis needs Hopper, describe it as REA's local analysis engine and note that it is a separate Mac app with its own license. Then run `npx -y rea-agents setup --yes`.
4. If macOS or an installer requests human input, tell the user exactly what needs attention. After they finish, rerun setup and doctor.
5. If setup registers a new MCP server, tell the user to restart their coding agent to load all REA tools. Direct CLI commands remain available before restart.

## Locate the app

Accept a human-readable app name. Search macOS application locations and system metadata. If one clear match is found, continue without asking for a path. If several apps match, show their names and locations and ask which one the user means. If none match, ask where the app is installed.

REA accepts a `.app` bundle directly. Do not expose its internal `Contents/MacOS` path unless it helps explain an error.

## Investigate

Briefly tell the user what you will investigate. Open the app with `open_binary`, begin with `binary_overview`, and narrow the investigation around the requested feature. Use decompilation, strings, names, callers, callees, and cross-references as needed.

For applications, ZIP/APK/IPA packages, or Electron ASAR archives, call
`inventory_artifact` before extraction. Follow its deterministic occurrence
pages and cite graph manifest IDs. `extract_artifact` requires explicit user
approval, an absent absolute output root, and selected occurrence IDs; never
extract every entry implicitly. Symlinks and encrypted entries are inventory
facts, not extractable files. Nested containers require a separate deliberate
inventory step.

Explain conclusions in plain language. Point to the relevant decompiled code, strings, names, and connections so the user can see how the explanation was reached. Do not claim to recover original source code or automatically clone an application.

Search uses bounded deterministic pages. Prefer literal mode; use regex mode only
when regex semantics are needed, and continue from `next_offset` while
`has_more` is true. Treat nullable permissions and explicit unavailable metadata
as unknown, never as `false`.

Every successful analysis result is Evidence v2. Cite evidence IDs and preserve
limitations and residual unknowns. Process capture is disabled by default,
requires per-call approval plus operator policy, and uses host networking only
when the operator explicitly permits it. It is behavioral evidence, not a
security sandbox.

Do not let unanswered questions disappear. Use `record_unknown` only with
explicit approval, attach supporting and contradicting evidence IDs, and record
the authority/environment still required. Use `update_unknown` with the current
`expected_revision`; stale updates must be re-read, not retried blindly. A
verified resolution needs qualifying observed evidence. Inference, withdrawn,
and out-of-scope dispositions are never substitutes for observed behavior.
Set `unknown_registry_approved: true` on `trace_feature` or
`capture_process_scenario` only when the user approves durable automatic
recording of their bounded residuals. The same flag on a direct operation
records typed provider unavailability, and on `compare_process_captures`
records an observed disagreement as a contradiction.

Use `compare_artifacts` with one record or bounded arrays of
`inventory_artifact` Evidence pages per side. Pages must share one manifest;
collect all node, occurrence, and edge pages for exhaustive comparison. It
compares stable occurrence paths, content, metadata, and graph relations,
cites both evidence sets on every delta, and paginates changes. Incomplete
inventories are truncated or unknown, never equivalent. Set
`unknown_registry_approved: true` only with approval to preserve the
disagreement or missing evidence as a residual unknown.

Use `compare_functions` with explicit `analyze_function` Evidence page sets;
it does not perform fuzzy whole-binary matching. Collect every pseudocode,
assembly, collection, and CFG page when exhaustive comparison matters.
Absolute addresses are volatile only in CFG topology; pseudocode constants are
never stripped. Omitted assembly, truncated scans, unavailable reference kinds,
and cross-provider text remain unknown rather than equal.

Use `compare_bundles` for canonical Evidence v2 bundle membership and
residual-unknown history changes. Pair cross-version observations explicitly;
the tool never guesses record identity. One-sided records prove only bundle
inclusion or omission, not behavioral absence. Use the returned canonical
bundle digests to anchor paginated reports.

Use `find_changed_behavior` to combine existing comparison Evidence. Runtime
process differences are observed changes; artifact and function differences
remain static candidates, not causal proof. Supply complete comparison pages.

Use `build_call_path` with explicit `analyze_function` Evidence groups from one
artifact and provider. Select endpoints by exact address. Missing dossiers,
incomplete callee pages, or a depth frontier make absence unknown; found paths
remain valid and cite each contributing dossier.

Use `correlate_static_and_runtime` only with explicit mappings between exact
static and runtime comparison findings. A matching pattern is a hypothesis,
never proof of causality. Declare side alignment; unmapped similarities are not
correlated.

Use `verify_reconstruction` with a finite typed specification and canonical
Evidence bundle. Pass means all declared claims passed with comparable
authority, not global implementation equivalence. Missing, limited, active-
unknown, or incompatible evidence stays unknown; observed differences fail.

## Build

When requested, use normal coding tools to build a version suited to the user's project, stack, interface, and requirements. Keep the implementation tied to what the investigation established, and distinguish observed behavior from assumptions or design choices.

## Human input and cleanup

Hopper or macOS may show a window that needs human input. Tell the user what appeared and ask them to handle it; do not guess or take over unrelated UI. Call `close_binary` when the investigation is complete.
