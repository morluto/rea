# MCP runtime contracts

## Identity and discovery

`rea://server/identity` and `binary_session` report the package, server, SDK,
negotiated protocol, skill, and schema-sensitive catalog identities separately.
An absent live comparison is `unknown`, never aligned. Callers can supply the
expected package version, catalog digest, or registered server path to
`binary_session`; a mismatch means the registered MCP process must be restarted.
`rea doctor` separately inspects supported JSON/TOML client registrations,
reports their command vectors as aligned, stale, missing, or invalid, and keeps
live-server state `unknown` unless the active connection supplies identity.

Tool names remain stable. `binary_session.tool_availability` explains each
operation with a stable availability reason instead of silently hiding it.
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

## Progress and cancellation

REA accepts ordinary `tools/call` progress tokens. Updates are monotonic,
rate-bounded to at most one intermediate update per 100 ms, and always allow a
terminal update. Unknown totals are omitted; REA does not fabricate percentages.
Provider calls receive the request cancellation signal. Artifact traversal,
hashing, cross-version scanning/checkpoints, Hopper requests, and process capture
check the same signal. Cancellation is distinct from timeout. A cleanup failure
uses `cleanup_incomplete` and lists only the owned resource kinds that remain.
Derived comparisons and reconstruction verification yield before computation
and before publication, so cancellation cannot race with successful Evidence.

CLI calls work without a progress token and translate SIGINT into the same
AbortSignal used by providers. Existing controlled-process cleanup and provider
shutdown rules still apply; REA never kills a process it cannot prove it owns.

## Evidence resources

Evidence remains inline for compatibility and successful Evidence-producing
tools also return `resource_link` content. Session resources are connection-local:

- `rea://evidence/{evidenceId}` returns the complete immutable Evidence v2 record.
- `rea://evidence/{evidenceId}/section/{section}` returns a bounded result section.
  Stable sections include `result`, `terminal`, `filesystem`, `process`,
  `protocol`, `nodes`, `occurrences`, and `edges` when present.
- `rea://unknown/{unknownId}` returns the current residual-unknown head and its
  immutable revision history.
- `rea://unknowns/active` returns current unresolved heads.
- `rea://snapshot/{snapshotDigest}` returns the current immutable analysis
  snapshot when its canonical content digest matches.
- `rea://artifact/{manifestId}/{collection}` returns a canonical artifact
  `nodes`, `occurrences`, or `edges` page with Evidence provenance.
- `rea://function/{targetSha256}/{address}` returns a retained function dossier
  for the exact target and address.
- `rea://workspace/{workspaceId}/revision/{revision}` returns an immutable,
  CAS-linked investigation workspace revision retained by this session.

Successful automatic cross-version investigations include both Evidence and
workspace `resource_link` blocks. Workspace resources preserve revision and
`previous_revision_digest` commitments; persistent workspace files remain
subject to configured read/write roots.

An Evidence URI is discoverability, not authorization. It cannot authorize file
access, extraction, mounting, execution, or networking. IDs disappear when the
session ends unless the existing Evidence bundle or workspace persistence flow
explicitly retains them.

## Permission policy

All local side effects use one scope vocabulary: capability, canonical roots,
executables, environment variable names, network mode, mount permission, exact
operation identity, and grant lifetime. Environment values and captured content
are never part of a grant or denial.

Existing environment settings map to administrator ceilings. They remain the
maximum authority:

- process roots, executables, environment names, and external networking;
- Evidence read/write roots;
- investigation input and workspace roots;
- snapshot read/write roots;
- reference-source roots;
- native mount enablement.

Artifact extraction retains its existing explicit per-call approval and maps to
an administrator root ceiling of `/` for compatibility.

`rea policy status`, `list`, `explain`, and `revoke` inspect the same evaluator
used by MCP. Optional project grants require both
`REA_PERMISSION_PROJECT_ROOT` and `REA_PERMISSION_PROJECT_STORE`. The store is
atomically written with mode `0600`, bound to the canonical project root, and is
never enabled by default. Send `SIGHUP` to the REA MCP process after a trusted
local policy change; ceilings, administrator grants, and project grants reload
without restarting. Revocation affects future operations; an already-running
operation retains the decision made at its preflight boundary.
`rea policy revoke <grant-id>` displays the exact grant and requires interactive
confirmation; automation must pass `--yes` (or `-y`) explicitly.

Denials use the shared `permission_required` schema with requested scope, missing
scope, administrator ceiling, elicitation support, and exact restart status.
Client-provided roots are context only and never grants.

`analyze_javascript_application` uses the `investigation_input` capability. Its
absolute `input_path` must be inside `REA_INVESTIGATION_INPUT_ROOTS_JSON` and the
request must set `approved: true` before any artifact read. Reading source-map
contents additionally requires `source_map_read_approved: true`; ordinary input
approval does not imply that separate authority.

## Integrity record-and-continue

Artifact integrity remains fail-closed by default. Record-and-continue requires
all three conditions:

1. operator policy `REA_ARTIFACT_INTEGRITY_CONTINUE_ENABLED=true`;
2. `integrity_policy=record-and-continue`;
3. explicit per-call `integrity_continue_approved=true`.

Contradictory bytes are quarantined from nested expansion, recorded with declared
and observed hashes, trust, provenance, path, and unpacked state, and bounded by
`max_integrity_mismatches`. Verified siblings continue. Comparisons classify the
result as a contradiction and reconstruction cannot treat it as unchanged.
`investigate-versions` accepts the same policy through
`--integrity-policy record-and-continue --integrity-continue-approved` and
`--max-integrity-mismatches`. Its Evidence pages and CAS-linked workspace retain
contradictions, so a completed run can resume without rescanning or weakening
trust labels.
