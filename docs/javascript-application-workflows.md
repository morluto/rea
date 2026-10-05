# Cross-layer JavaScript application workflows

REA derives a complete reachable feature trace from one authenticated JavaScript
Application Graph and compares two authenticated graph versions. The MCP tools
are `trace_application_feature`, `trace_javascript_semantics`,
`compare_application_versions`, `compare_source_to_bundle`, and
`compare_javascript_export_shapes`; their CLI equivalents use the same names
with hyphens.

These workflows consume Evidence produced by
`analyze_javascript_application` or `reconcile_javascript_runtime`. They do not
read an artifact, execute application code, attach to a process, or open a
native-analysis provider. Static artifact observations, passive runtime
observations, relationship inferences, and unknown or unavailable facts retain
their original graph authority.

`analyze_javascript_application` Evidence retains the structural JavaScript
Application Graph and a separate semantic relation graph bound to the same root
artifact digest and structural graph ID. Semantic tracing requires the semantic
relation graph and reports when it is unavailable rather than treating missing
data as an empty graph.

## Feature tracing

Select one literal seed kind: node ID, route, string, API, IPC channel, module,
or native export. Matching is exact or literal substring matching; regular
expressions and executable predicates are not accepted. The trace includes all
matching seeds and the complete graph reachable in the selected direction.

The result contains the matching basis, complete reachable subgraph, terminal
paths, authority summaries, and native handoffs. A handoff binds
the exact native artifact digest and requested exports from the application
graph. Existing Hopper or Ghidra Evidence is linked only when its subject digest
matches exactly. Otherwise the result recommends provider-neutral follow-up
tools and reports `requires-provider-analysis`; it never starts or switches a
provider implicitly.

## Semantic relation tracing

`trace_javascript_semantics` queries the authenticated companion graph without
rereading mutable files. A seed may identify a semantic or application node,
literal, function fingerprint, property, endpoint, event, or boundary field.
The query declares backward provenance, forward influence, callers, or
ownership and can restrict admitted relation kinds. REA returns every matching
seed and the complete reachable subgraph; callers do not choose node, relation,
depth, function, module, seed-match, or page budgets.

The extractor covers lexical definitions and reads, literal seeds, static
property slots, object reads/writes/spreads/destructuring, closure captures,
uniquely resolved local calls, argument/return flow, and explicit Promise
construction, chaining, aggregation, await, return, assignment, and
detachment. It also recovers static candidates for EventEmitter
registrations/removals and dispatch, Node timers and cancellation handles, asynchronous
`node:child_process` creation and ownership, configuration sources and direct
defaults, request construction and response consumers, parse/coercion/
validation boundaries, and built-in resource acquisition/release.

Function fingerprints commit normalized syntax, control-flow shape, relation
shape, literal sets, arity, and detected effects without using local names or
source offsets. Equal duplicate fingerprints remain ambiguous. Dynamic
calls/properties/names, parser recovery, unresolved handles, and unsupported API
shapes stay explicit unknowns; a missing relation is never reported as proven
behavioral absence.

Semantic relations use static-inference authority. `resolved` means the static
target identity was unique within admitted analysis; it does not mean the path
executed. Candidate edges are excluded by default, require explicit opt-in, and
keep the result ambiguous. Runtime Evidence can later corroborate an exact
mapped candidate, but structural reachability, semantic influence, runtime
observation, and causal proof remain separate claims.

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
links, limitations, and a `changed_from` graph containing all compared nodes,
their observations, and relationships.

One-sided absence is `added` or `removed` only when the opposite input graph has
complete coverage. With partial, unavailable, or truncated input, the same
condition is `unknown`. The comparison retains every classified item and
ambiguity candidate. Coverage carries omitted counts and limits from each input
graph; comparison adds no caller-selected item, candidate, graph node, or edge
budget. Unresolved comparison items are recorded as a residual unknown linked
to the comparison Evidence in a live session.

## Historical source-to-bundle comparison

`compare_source_to_bundle` compares one cryptographically committed
`HistoricalSourceGraph` with authenticated application-graph Evidence. The
stable scoring model reports every admitted signal and weight: exact source
digest, source-map original path, exact current path, path suffix, basename, and
language extension. Exact digest wins over location inference; weak basename
or extension evidence never forces a mapping.

Each historical source file is classified as `unchanged`, `modified`,
`removed`, `split`, `merged`, `duplicated`, or `unknown`. Multiple equally
scored path mappings form a static split inference. Multiple current
nodes with the exact historical digest are duplicated; multiple historical
paths with exact identity to one current node are merged. `removed` requires
complete historical and application inventories. The comparison analyzes and
returns all source files, candidate nodes, and matching signals represented in
the supplied graphs. Partial inventories remain unknown where absence cannot
be established. These static mappings do not claim runtime loading or semantic
equivalence.

## Export return-shape comparison

`compare_javascript_export_shapes` selects exactly one module path and export
name on each authenticated graph. Missing or duplicate exact selectors return
candidate inventory and an unknown result; the tool never chooses a fuzzy
match. An export is linked to a callable only through exact lexical/module
relationships recovered by the AST analysis.

Direct return expressions, including expression-bodied arrows, are evaluated
through an execution-free value lattice. Literal object fields and direct
return sites are represented in the result. Calls, dynamic spreads, computed
keys, and parser recovery remain partial or unknown.
Nested callable returns are not assigned to their parent callable. Projected
graph observations carry source ranges but never source text.

Return variants pair only when a literal discriminant such as `/type` has one
unique occurrence on each side and pairing is reciprocal. Changes use JSON
Pointer paths with `added`, `removed`, `changed`, or `unknown` status. A missing
field is added or removed only when the relevant parent-property coverage is
complete on both shapes. The output includes exact selector candidates,
omissions, Evidence links, coverage, and limitations; it does not execute
JavaScript. When runtime semantics matter, run behavioral probes directly
against the relevant application versions and capture them through the
available browser, Electron, or process workflows.

## CLI and verification

All five CLI commands accept inline JSON or a path to a JSON file. Put the full
Evidence records in the workflow input, as in the corresponding MCP tool; the
CLI does not resolve Evidence IDs from a separate bundle.

For two operator-provided directories or ASARs, run:

```bash
npm run verify:application-workflows -- \
  --left /absolute/path/to/version-a \
  --right /absolute/path/to/version-b
```

The verifier reconstructs both versions independently, compares them, runs one
literal trace when a seed is available, and compares the first common exact
export return shape when present. It prints only graph, artifact, and Evidence
identifiers plus matching, changes, summary, handoff, and coverage statistics;
it does not print source text. Use `--seed-kind` and `--seed-value` to select a
specific route, string, API, channel, module, native export, or node ID. Supply
all four `--left-module-path`, `--left-export-name`, `--right-module-path`, and
`--right-export-name` options to verify an explicit export pair.

Because source Evidence and derived Evidence are retained by the normal session
ledger, evidence bundles and analysis snapshots can carry these records without
another persistence format.

## Runtime evidence

Static graph workflows do not execute recovered code. When runtime semantics
matter, run behavioral probes directly against the relevant application
versions and capture them through the available browser, Electron, or process
workflows. Those observations do not prove behavior in an unobserved app
version or environment.
