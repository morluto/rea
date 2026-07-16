# Cross-layer JavaScript application workflows

REA derives a bounded feature trace from one authenticated JavaScript
Application Graph and compares two authenticated graph versions. The MCP tools
are `trace_application_feature` and `compare_application_versions`; their CLI
equivalents are `rea trace-application-feature` and
`rea compare-application-versions`.

Both workflows consume Evidence v2 produced by
`analyze_javascript_application` or `reconcile_javascript_runtime`. They do not
read an artifact, execute application code, attach to a process, or open a
native-analysis provider. Static artifact observations, passive runtime
observations, relationship inferences, and unknown or unavailable facts retain
their original graph authority.

## Feature tracing

Select one literal seed kind: node ID, route, string, API, IPC channel, module,
or native export. Matching is exact or literal substring matching; regular
expressions and executable predicates are not accepted. Direction, depth,
nodes, edges, paths, and seed matches all have caller-visible limits.

The result contains the matching basis, a bounded subgraph, terminal paths,
authority summaries, truncation frontier, and native handoffs. A handoff binds
the exact native artifact digest and requested exports from the application
graph. Existing Hopper or Ghidra Evidence is linked only when its subject digest
matches exactly. Otherwise the result recommends provider-neutral follow-up
tools and reports `requires-provider-analysis`; it never starts or switches a
provider implicitly.

## Version comparison

REA pairs entities only when a tier produces one unique candidate on each side.
The tiers are exact content digest, exact module-source digest, exact node
identity, source-map identity, structural fingerprint, and a semantic key for
non-module entities. Lower tiers never override a higher unique match.

Module ordinals, stable minified names, and fuzzy text similarity are not
persistent identities. Duplicate candidates remain ambiguous. Source-map and
structural matches are high/medium-confidence inferences rather than exact
facts. Each item is `unchanged`, `added`, `removed`, `changed`, or `unknown`,
and the result includes its basis, candidates, changed dimensions, Evidence
links, limitations, and a bounded `changed_from` graph.

One-sided absence is `added` or `removed` only when the opposite input graph has
complete coverage. With partial, unavailable, or truncated input, the same
condition is `unknown`. Output truncation separately reports omitted comparison
items, candidate references, graph nodes, edges, and observations. With
`unknown_registry_approved: true`, unresolved comparison items can be retained
as a residual unknown in a live session.

## CLI and verification

Both CLI commands accept inline JSON or a JSON file up to 64 MiB. The input is
the same object used by the corresponding MCP tool.

For two operator-provided directories or ASARs, run:

```bash
npm run verify:application-workflows -- \
  --left /absolute/path/to/version-a \
  --right /absolute/path/to/version-b \
  --source-map-read-approved
```

The verifier reconstructs both versions independently, compares them, and runs
one literal trace when a seed is available. It prints only graph, artifact, and
Evidence identifiers plus matching, summary, handoff, and coverage statistics;
it does not print source text. Use `--seed-kind` and `--seed-value` to select a
specific route, string, API, channel, module, native export, or node ID.

Because source Evidence and derived Evidence are retained by the normal session
ledger, evidence bundles, analysis snapshots, and investigation workspaces can
carry these records without another persistence format.

## Controlled replay boundary

These shipped workflows never execute a graph node or recovered module. A
future extracted-module replay may consume an exact trace handoff only through
the separate `javascript_replay` authority, two-phase content-bound approval,
and mandatory Linux OS sandbox fixed by
[ADR-0002](adr/0002-controlled-replay-authority-and-sandbox.md). Browser,
Electron, Process Capture, artifact-read, and static-analysis approvals do not
authorize that execution.

Replay observations will retain `controlled-replay` authority. They cannot
promote static inference into passive runtime observation or prove that the
original application, renderer, preload, main process, or remote service
behaved identically.
