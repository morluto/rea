# MCP runtime contracts

## Generated catalog

Run `npm run build:cached` in a source checkout to generate the machine-readable
catalog at `docs/public/product-catalog.json`. Documentation deployments serve
the same file at [/rea/product-catalog.json](/rea/product-catalog.json). PR CI retains it with the packaged
skill and portable conformance projections in the `generated-docs` artifact.
These outputs describe the exact source revision being built; they are not
checked-in snapshots. For a running server, `binary_session` remains the
authoritative source of catalog identity and tool availability.

## Identity and discovery

`binary_session` reports the active package, server, SDK, and negotiated
protocol details. `rea doctor` separately inspects supported JSON/TOML client
registrations, reports their command vectors as aligned, stale, missing, or
invalid, and keeps live-server state `unknown` unless the active connection
supplies identity.

`tools/list` returns the complete canonical tool inventory, including tools that
are currently unavailable. Opening or closing a target or observing a provider
health transition leaves that catalog unchanged and does not emit
`notifications/tools/list_changed`.

Advertised input and output schemas contain no reachable recursive references.
The input compatibility profile limits nesting to ten object, array, and
`anyOf`/`oneOf`/`allOf` levels, following local references per path. Property
maps, reference definitions, and example data do not add schema levels. Tests
check the complete catalog after SDK conversion and its generated counterpart.
This is REA's local compatibility profile; individual model APIs can impose
additional limits.

For passive `compare_web_captures` inputs, pass each complete
`inspect_web_page` result in `before.inspection` or `after.inspection`, with an
optional complete `discover_webmcp_tools` result in the matching `webmcp` field.
The input schema describes these producer-result objects as round-trip payloads.
For scenario comparisons, pass complete `capture_browser_scenario` results in
`before_scenario` and `after_scenario`. REA validates all nested fields with the
original capture schemas; observation output schemas remain complete. Scenario
authoring inputs and comparison normalization options retain their full
advertised structure.

Call `binary_session` with `{}` and read `result.tool_availability` to choose a
callable operation for the current target, provider, host, and negotiated client
capabilities. The default result includes the complete inventory with each
tool's availability, reason, and remediation. Each entry also reports required
and optional negotiated client features plus the currently missing features.
The optional inputs `expected_package_version`, `expected_catalog_digest`, and
`expected_server_path` compare the live session with the caller's expectations.

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
Native call tracing and process capture retain available observations in
`details.partial_observation` on failure, including when cleanup succeeds.
The observation reports its partial coverage; cleanup details describe host
state separately from the execution failure.
Derived comparisons and reconstruction verification yield before computation
and before publication, so cancellation cannot race with successful Evidence.

`analyze_javascript_application` also yields between reconstruction phases and
during graph/result sealing, cross-graph binding checks, Evidence JSON validation,
and canonical hashing. Its final result validation reuses exact graphs whose
owned constructors validated and completely sealed them; imported graphs still
receive full schema and commitment checks.
Cancellation observed before completion returns `cancelled` and prevents the
provisional result from entering the session ledger; prior Evidence stays usable.
Single-file parsing, graph construction, and validation of imported graphs
still run synchronously, so control messages can wait for those
phases to release the event loop. A rejected client promise alone does not
establish that the server has stopped its work.

CLI calls work without a progress token and translate SIGINT into the same
AbortSignal used by providers. Existing controlled-process cleanup and provider
shutdown rules still apply; REA never kills a process it cannot prove it owns.

## Ghidra first-query deadlines and recovery

A successful MCP initialize handshake establishes the REA connection.
`open_binary` then selects a target and provider binding; it does not establish
that Ghidra has finished importing the target. The first Ghidra-backed query,
such as `binary_overview`, starts the engine and waits for import, default
auto-analysis, bridge connection, and health readiness before returning analysis.

These deadlines have different owners:

| Deadline             | Owner and effect                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP initialize       | The client bounds transport/REA connection startup, before any target query.                                                                                     |
| Ghidra startup       | REA allows 330,000 ms for engine readiness from the first provider query; startup failure is reported by that query.                                             |
| Individual tool call | The client bounds its wait, including cold engine startup. The pinned client SDK 2.3.1 defaults to 60,000 ms and can cancel earlier than REA's startup deadline. |

For an already connected client using the pinned SDK, request options are the
**second** argument of `callTool`:

```js
const overview = await client.callTool(
  { name: "binary_overview", arguments: {} },
  {
    timeout: 240000,
    onprogress: ({ progress, total, message }) => {
      console.error({ progress, total, message });
    },
  },
);
```

The SDK's `onprogress` option supplies a progress token and handles matching
notifications. A raw MCP client can instead send `_meta.progressToken` in the
request and handle `notifications/progress`. Progress reports do not establish
engine readiness or a percentage of Ghidra auto-analysis. A longer server
startup allowance does not extend the client's deadline; progress also does not
extend it unless the client explicitly implements that policy.

The 240-second setting is a measured example, not a universal timeout: a
controlled Linux x64/WSL2 fixture took about 64 seconds for its first overview
with Ghidra 12.1.4 on a mounted NTFS installation, native JDK 21, two CPUs, and a
512 MiB Java heap. Target size, storage, and analysis work can change that time.
Configure the deadline in the caller's existing request settings; it is not a
tool argument, setup grant, or server-side automatic extension. CLI analysis has
no MCP client request deadline, but keeps the provider startup deadline and
SIGINT cancellation.

If the client timed out or cancelled during startup, the pending query may have
been interrupted. Reissuing `open_binary` for the same active target can reuse
the current client, so it is not a fresh-start recovery. On the same connection:

1. Keep any useful inline Evidence, or export a bundle before closing if retained
   records are needed. `binary_session` can show the selected binding and its
   recorded state; target selection alone does not prove engine readiness.
2. Call `close_binary` and check its result. It drains owned work, closes the
   provider, and clears retained session records. A `cleanup_incomplete` result
   must be addressed according to its reported owned resources before retrying.
3. Call `open_binary` with the same caller-selected path and
   `provider_id: "ghidra"`, then retry the first query with an appropriate client
   deadline. The connection and selected provider do not need to change.

This close/reopen flow was exercised on one real Linux stdio connection after a
controlled startup timeout, followed by a successful overview and function
analysis. It is not a Windows/macOS coverage claim. REA cleans only resources it
owns and never switches to another provider automatically. A provider timeout,
installation failure, or host permission denial needs its own reported recovery;
increasing a client deadline alone does not fix those failures.

## Tool results

Evidence-producing tools return `{ result, evidence_id, evidence }` in both
text and structured content. `evidence` is the complete canonical Evidence
record, including `normalized_result`, which equals `result`. The same record
is retained in the session bundle. Read `result` directly, or pass `evidence`
to a compatible comparison tool: `analyze_function` Evidence can be passed
directly to `compare_functions`, and `inspect_artifact` Evidence to
`compare_artifacts`. Use `get_evidence_bundle` when the task needs broader
retained session history or an explicit bundle for transfer.

REA prepares complete MCP results within the pinned stdio client's 10 MiB
receive-buffer budget, including both text and structured representations and
room for the JSON-RPC envelope. If a result cannot fit, REA returns
`resource_constraint` with `details.resource: "transport"` before constructing
a document-sized string. Analysis Evidence remains complete in the current
session. Its exact reference is reported in
`details.reported_limits.evidence_reference`; use it with a focused application
workflow, or call `export_evidence_bundle` with a destination path. Complete
bundle exports stream canonical JSON into an atomically published file. A broad
follow-up or `get_evidence_bundle` can also exceed the response budget; exporting
preserves the complete session without sending it through a single MCP frame.

Clients that explicitly configure a larger receive buffer can set the REA
server's `REA_MCP_MAX_RESPONSE_BYTES` environment variable to the same byte
count. This setting must be a safe decimal integer at least 10485760; REA
reserves 1024 bytes for the envelope. Raising it restores complete inline
delivery for responses that fit that buffer and Node's single-string limit.
It does not change the client's buffer, analysis coverage, or retained content.
Ordinary responses keep their existing complete result contract.

## Retained application Evidence inputs

`trace_application_feature`, `trace_javascript_semantics`,
`compare_application_versions`, `compare_source_to_bundle`, and
`compare_javascript_export_shapes` accept complete inline application Evidence
or an exact reference to a record already retained by the current connection:

```json
{
  "name": "trace_application_feature",
  "arguments": {
    "application": {
      "kind": "retained-evidence",
      "evidence_id": "ev_<64 lowercase hex characters>"
    },
    "seed": { "kind": "module", "value": "search.js", "match": "exact" }
  }
}
```

Use the `evidence_id` returned by `analyze_javascript_application` (or another
compatible application-graph producer). Comparisons accept this form in `left`
and `right`; each side can independently be inline or retained. Native
observation arrays continue to take complete inline Evidence. Results and their
Evidence remain complete inline, and both input forms pass the same semantic,
identity, authority, and provenance checks without running the producer again.

References belong to the current connection's Evidence ledger. Opening another
target preserves retained records; `close_binary` clears them, even when no
binary is active. A fresh connection has its own ledger. A missing reference
reports its exact ID and `details.reason: "missing"`; the server cannot infer
whether it was never recorded, cleared, or retained by another connection.
Supply complete inline Evidence, repeat its producer, or import an exported
Evidence bundle before referencing that imported record. Export a bundle before
closing if the investigation needs it later.

CLI application workflows continue to read portable inline Evidence from files
and run the same analysis workflows; a standalone CLI invocation cannot resolve
another MCP connection's retained records. No additional lookup call, provider
selection, or approval step is required for a same-session follow-up.

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

REA does not require permission grants or per-call approval flags. Setup still
prints its plan and requires confirmation before changing configuration or
installing Hopper. MCP clients control their own confirmation UI.

Tool annotations describe effects and are hints, not authorization controls
([MCP ToolAnnotations](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations)).
`readOnlyHint` includes session state: an analysis call that records additive
Evidence is marked non-read-only even when it leaves the target unchanged.
`destructiveHint` describes possible data loss, not ordinary Evidence recording.
Effect metadata covers possible behavior across supported inputs: DMG inventory
can launch `hdiutil` and create an owned temporary mount directory; extraction
creates a fresh output directory on every call. Comparing supplied web captures
or PNG artifacts uses local data without contacting the browser.

Host requirements remain in force. macOS may deny Accessibility,
Screen Recording, or native mounting; provider tools require their selected
analysis runtime. These failures are reported at the operation that needs
them. A configured provider or an endpoint alone does not establish that a
target is supported.

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
