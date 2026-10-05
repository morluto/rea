# MCP runtime contracts

## Identity and discovery

`binary_session` reports the active package, server, SDK, and negotiated
protocol details. `rea doctor` separately inspects supported JSON/TOML client
registrations, reports their command vectors as aligned, stale, missing, or
invalid, and keeps live-server state `unknown` unless the active connection
supplies identity.

Canonical tool names remain stable, while `tools/list` advertises only the
operations callable for the current target, provider, host, and
negotiated client capabilities. `binary_session.tool_availability` remains the
complete inventory: it explains advertised and hidden operations with stable
availability reasons and remediation. Each entry also reports required and
optional negotiated client features plus the currently missing features.
Opening or closing a target or observing a provider health transition emits
`notifications/tools/list_changed`.

`binary_session.analysis_provider_candidates` is authoritative for deep-engine
discovery. Target-free discovery is sorted by provider ID, reports host
availability and `unknown` target support, and does not create an analysis
client. `open_binary.provider_id` accepts a concrete provider ID or `auto`; it
uses the same parser and selection policy as CLI `--provider` and
`REA_ANALYSIS_PROVIDER`. A successful deep open exposes one immutable provider,
concrete version, selection source, and complete analysis profile through
`analysis_provider_binding`. Ambiguity and unknown, unavailable, or unsupported
choices return typed selection details. A selected provider is never replaced
automatically after a runtime failure.

Every successful target transition allocates `binary_session.analysis_run.run_id`
before any provider startup. `process_lineage` is `not_observed` until a dynamic
provider starts, then becomes `snapshots` with every started provider's identity
and retained ownership observation. Each observation records `observed_at` and
is `unavailable` with a reason when ownership could not be revalidated, or
`verified` with launcher PID, parent PID, process group, and descendants observed
at that bounded check. These are historical snapshots, not live process
inventories, and do not claim that no short-lived descendant existed.

## Progress and cancellation

REA accepts ordinary `tools/call` progress tokens. Updates are monotonic,
rate-bounded to at most one intermediate update per 100 ms, and always allow a
terminal update. Unknown totals are omitted; REA does not fabricate percentages.
Provider calls receive the request cancellation signal. Artifact traversal,
hashing, version comparisons, Hopper requests, and process capture
check the same signal. Cancellation is distinct from timeout. A cleanup failure
uses `cleanup_incomplete` and lists only the owned resource kinds that remain.
Derived comparisons and reconstruction verification yield before computation
and before publication, so cancellation cannot race with successful Evidence.

CLI calls work without a progress token and translate SIGINT into the same
AbortSignal used by providers. Existing controlled-process cleanup and provider
shutdown rules still apply; REA never kills a process it cannot prove it owns.

## Tool results

Evidence-producing tools return their result and Evidence context inline. Read
that result directly. Use `get_evidence_bundle` when the task needs broader
retained session history or an explicit bundle for transfer.

## Aggregate native context

`get_navigation_context` composes the selected document, current address, and
current/containing procedure. Its capability inventory exposes a
`current_selection` mode and an `explicit_document` mode; the latter works when
the caller supplies `document` and the provider lacks `current_document`. A
cursor outside a procedure is represented as
`procedure: null`. `inspect_address_context` requires an explicit address and
returns name, procedure, comment, inline-comment, and bookmark facets;
unsupported facets are local `unavailable` outcomes. Use `current_document`,
`current_address`, and `current_procedure` for direct single-field lookups; use
the aggregate tools when you need related context together.

## Request scope and local effects

Each tool request names the target and lifecycle it will use. Browser calls
carry a loopback CDP endpoint and target ID, with optional origin filters;
process and Electron scenarios carry the executable, arguments, actions, and
cleanup behavior; artifact tools carry the input path and requested operation.
REA runs the declared request directly and does not infer a broader target or
action from it.

Host requirements remain in force. macOS may deny Accessibility,
Screen Recording, or native mounting; Linux replay requires its sandbox
prerequisites; provider tools require their selected analysis runtime. These
failures are reported at the operation that needs them. A configured provider
or an endpoint alone does not establish that a target is supported.

Evidence bundles, snapshots, and extraction use the paths and output behavior
declared by their tools. Artifact extraction materializes the selected regular
files into a fresh REA-chosen temporary directory and reports its path.

`analyze_javascript_application` reads the supplied local directory or ASAR path
and returns its result and Evidence inline.

## Integrity record-and-continue

Artifact integrity fails closed by default. A request can explicitly select
`integrity_policy=record-and-continue` when the investigation needs verified
siblings to continue after a mismatch.

Contradictory bytes are quarantined from nested expansion and recorded with
declared and observed hashes, trust, provenance, path, and unpacked state.
Verified siblings continue. Comparisons classify the result as a contradiction
and reconstruction cannot treat it as unchanged.
