# MCP runtime contracts

## Identity and discovery

`binary_session` reports the active package, server, SDK, and negotiated
protocol details. `rea doctor` separately inspects supported JSON/TOML client
registrations, reports their command vectors as aligned, stale, missing, or
invalid, and keeps live-server state `unknown` unless the active connection
supplies identity.

Canonical tool names remain stable, while `tools/list` advertises only the
operations callable for the current target, provider, policy, host, and
negotiated client capabilities. `binary_session.tool_availability` remains the
complete inventory: it explains advertised and hidden operations with stable
availability reasons and remediation. Each entry also reports required and
optional negotiated client features plus the currently missing features. Form elicitation is optional for
`capture_process_scenario`: an existing grant remains usable without it, while
a missing grant cannot be elicited by a client that does not advertise it.
Opening or closing a target, reloading policy, or observing a provider health
transition emits `notifications/tools/list_changed`.

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

## Permission policy

All local side effects use one scope vocabulary: capability, canonical roots,
executables, environment variable names, network mode, mount permission, exact
operation identity, and grant lifetime. Environment values and captured content
are never part of a grant or denial.

Existing environment settings map to administrator ceilings. They remain the
maximum authority:

- process roots, executables, environment names, and external networking;
- native mount enablement.

Evidence bundles and analysis snapshots use the path supplied to the CLI or MCP
tool; they do not require configured roots or separate read/write grants.

Artifact extraction takes no path or occurrence selectors. It materializes all
regular files into a fresh REA-chosen temporary directory. The write still
passes through the active permission evaluator; the tool caller does not choose
an output path.

`rea policy status`, `list`, `explain`, and `revoke` inspect the same evaluator
used by MCP. Optional project grants require both
`REA_PERMISSION_PROJECT_ROOT` and `REA_PERMISSION_PROJECT_STORE`. The store is
atomically written with mode `0600`, bound to the canonical project root, and is
never enabled by default. Send `SIGHUP` to the REA MCP process after a trusted
project-store change; project grants reload without restarting. Environment
settings belong to the process environment, so changing an administrator
ceiling in an MCP registration requires restarting that registered server or
its owning client.
Revocation affects future operations; an already-running operation retains the
decision made at its preflight boundary.
Once and session grants are connection-local overlays. They cannot authorize a
second MCP connection, be consumed by another connection, or be cleared when a
different connection closes. Live connections evaluate those overlays against
the current process-wide ceilings and persisted grants, including successful
SIGHUP reloads.
`rea policy revoke <grant-id>` displays the exact grant and requires interactive
confirmation; automation must pass `--yes` (or `-y`) explicitly.

Denials use the shared `permission_required` schema with requested scope, missing
scope, administrator ceiling, elicitation support, and exact restart status.
Client-provided roots are context only and never grants.

Elicitation can add a once or session grant only inside an existing
administrator ceiling. A request outside that ceiling reports
`elicitation_supported: false` and `restart_required: true`; interactive consent
cannot silently widen administrator policy.

`analyze_javascript_application` reads the supplied local directory or ASAR path directly and returns its result and Evidence inline; no approval flag or root configuration is needed.

## Integrity record-and-continue

Artifact integrity remains fail-closed by default. Record-and-continue requires
all three conditions:

1. operator policy `REA_ARTIFACT_INTEGRITY_CONTINUE_ENABLED=true`;
2. `integrity_policy=record-and-continue`;
3. explicit per-call `integrity_continue_approved=true`.

Contradictory bytes are quarantined from nested expansion and recorded with
declared and observed hashes, trust, provenance, path, and unpacked state.
Verified siblings continue. Comparisons classify the result as a contradiction
and reconstruction cannot treat it as unchanged.
