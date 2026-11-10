# Analysis settings, limits, and recovery

This guide explains the runtime settings design for maintainers and developers:
who owns each value, when an update takes effect, how providers enforce it, and
how to extend the system. The public tool contract is in
[MCP contracts](../reference/mcp-contracts.md#editable-analysis-settings); recorded runtime
checks and their limitations are in the
[verification report](../verification/runtime-analysis-settings.md). The
[limit inventory](rea-limit-inventory.md) lists every numeric `REA_` limit, which
of them are runtime settings, and which stay restart-only.

## Problem and design boundary

A valid workload can exceed a conservative default. An oversized ASAR header
may prevent analysis of the entire archive; a slow Ghidra function may exceed
its decompile deadline. Requiring a new REA process to change either budget
interrupts the investigation and can discard reusable provider state.

REA exposes a curated set of analysis defaults through MCP so callers can
adjust a reported limit and retry the same workload in the running runtime.
Each setting has a typed value, resource bounds, an enforcement owner, and a
defined application point. The design applies across archive admission,
provider startup, operation deadlines, and worker memory requests.

The setter changes in-memory defaults. It does not edit arbitrary environment
variables, configuration files, MCP registrations, or provider installations.
Those mechanisms have different owners and lifetimes. It also cannot change a
client deadline, extend accepted work, release retained resources, or remove a
fixed representation limit. Exposing a setting requires a working enforcement
path, not just an entry in the tool schema.

Further ceilings that should become settings are tracked in
[#6176](https://github.com/morluto/rea/issues/6176). Naming honesty for limit
errors is [#5910](https://github.com/morluto/rea/issues/5910).

## Ownership and data flow

| Owner                                                                                                                                                                                                                   | Responsibility                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Domain definitions](https://github.com/morluto/rea/blob/main/src/domain/analysisSettingDefinitions.ts) and [types](https://github.com/morluto/rea/blob/main/src/domain/analysisSettings.ts)                            | Exact setting IDs, value types, shared bounds/defaults, units, provider/operation associations, application points, and structured limit metadata. Numeric constants stay with their domain owner. |
| [Launch parser](https://github.com/morluto/rea/blob/main/src/config/analysisSettings.ts)                                                                                                                                | Parse selected launch values once, preserving an invalid value as a typed configuration failure rather than substituting a default.                                                                |
| [AnalysisSettings](https://github.com/morluto/rea/blob/main/src/application/AnalysisSettings.ts)                                                                                                                        | Own one runtime's launch baseline, immutable override revisions, atomic updates, inspection, and accepted-operation snapshots. It does not own provider lifecycle or cleanup.                      |
| [Composition](https://github.com/morluto/rea/blob/main/src/main/eagerRuntime.ts) and [typed configuration views](https://github.com/morluto/rea/blob/main/src/config/runtimeAnalysisSettings.ts)                        | Inject the same settings reader into providers and workflows; translate overrides into the configuration each consumer understands.                                                                |
| Provider or resource owner                                                                                                                                                                                              | Resolve the effective budget, enforce it at the applicable boundary, and attach the actual value and known source to failures.                                                                     |
| [MCP registration boundary](https://github.com/morluto/rea/blob/main/src/server/EvidenceMcpServerCore.ts)                                                                                                               | Enter the operation's settings scope before invoking its handler.                                                                                                                                  |
| [Settings contracts](https://github.com/morluto/rea/blob/main/src/contracts/analysisSettingsContracts.ts) and [tool registration](https://github.com/morluto/rea/blob/main/src/server/registerAnalysisSettingsTools.ts) | Validate named requests and deliver inspection/update results without requiring an open target or healthy analysis provider.                                                                       |

The normal path is: composition creates the store, an MCP handler captures its
current revision, and providers read that snapshot when resolving budgets.
If an owner rejects work, it reports the effective limit through the shared
error projection. A subsequent settings update publishes a new revision for
later handlers. It does not reach into the failed operation or retry it.

### Accepted-operation snapshots

`AnalysisSettings.run()` installs the current immutable snapshot in
`AsyncLocalStorage`. Its `read` function returns that snapshot inside the
operation and the latest revision outside it. Providers depend on the reader
contract rather than on the mutable store or an ambient environment lookup.

Acceptance here is entry into the registered handler's settings scope, not
arrival of bytes at the MCP transport. Work queued or awaited within that scope
keeps its snapshot. Deferred server initialization must still dispatch through
the canonical scoped handler.

| Event                                                     | Revision used                       |
| --------------------------------------------------------- | ----------------------------------- |
| Operation A enters its handler, then waits for a provider | Current revision 0                  |
| A settings update publishes revision 1                    | Future handlers can read revision 1 |
| Operation A resumes and starts its worker                 | Its accepted revision 0             |
| Operation B enters its handler                            | Revision 1                          |

This gives each operation stable budget semantics even if another connection
updates settings while it waits. `next_worker` and `next_startup` describe where
an accepted value is applied; they do not cause workers or startups belonging
to an older operation to adopt a newer revision.

Inspection deliberately reads the store's current defaults, rather than the
calling operation's snapshot. It reports `active_values.status: "not_observed"`:
an inspection result cannot establish the budget or remaining time of an
already-running worker.

### Composition and embedding

The MCP runtime creates one store and supplies its reader to provider factories.
`createServer` uses a supplied store or creates one, and wires its default
providers to that store. An embedder supplying a custom binary session or other
provider must also inject the same reader into that provider's composition and
pass the store to `createServer`. Merely exposing the settings tools cannot
make a custom provider consume updates.

Keep default factories, explicitly supplied providers, transport composition,
and deferred handler dispatch covered separately where their wiring differs.
Resolve settings at the operation boundary; copying a runtime value into a
provider constructor would freeze it at launch. For entrypoints outside the
MCP wrapper, an embedder needing the same snapshot guarantee must establish
the operation scope with `AnalysisSettings.run()`.

## Name a default, then a setting when operators need headroom

Put the number in a named constant with a unit. Do not leave it as a magic
number at the call site.

When a workload may need more room, add a setting whose unset value is that
constant. Pure numeric contracts live in `src/domain/analysisResourceLimits.ts`
or their existing domain owner. `analysisSettingDefinitions.ts` binds the
curated runtime IDs to those same bounds, defaults and application points.
Environment parsers and recovery text stay under `src/config/`; register launch
schemas on `environmentSchema` so startup and doctor agree. Add launch settings
to `SELECTED_REGISTRATION_SETTINGS` when setup should forward them. Unset keeps
today's behavior. An invalid launch value remains a configuration failure,
never a silent fallback; its validation boundary determines whether MCP can
start (see [invalid launch configuration](#invalid-launch-configuration)). An
invalid runtime write is `invalid_request` and changes nothing.

For example, `regex.matching_deadline_ms` and its launch seed
`REA_REGEX_MATCHING_DEADLINE_MS` share a 5000 ms default, 1 ms floor and
2147483647 ms maximum. Node schedules a longer `setTimeout` delay as 1 ms.
Changing the runtime setting affects the next accepted search; changing the
launch environment affects the next REA process.

[`REA_MCP_MAX_RESPONSE_BYTES`](https://github.com/morluto/rea/blob/main/src/config/mcpResponseBudget.ts)
is the byte-budget shape: a decimal safe integer with a 10 MiB floor
(`MINIMUM_RESPONSE_BYTES`), the same shared schema, and no silent fallback. A
change needs a REA restart and a matching client receive buffer. It does not
raise REA's reserved string limit or Node's string ceiling. Like the regex
deadline, it is in `SELECTED_REGISTRATION_SETTINGS`, so setup forwards an
explicit selection into the client registration.

Windows ChangeTime admission waits out a fresh timestamp before recording a
baseline. `REA_WINDOWS_CHANGE_TIME_DRIFT_MS` (default 2000 ms, floor 1 ms,
maximum 60000 ms), `REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS` (default 25 ms,
floor 1 ms, maximum 1000 ms), and `REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS`
(default 40, floor 1, maximum 1000) are launch settings. Unset keeps those
defaults. An invalid value is a configuration error: it names the setting, the
rejected value, source `setting`, the default, the floor, and the maximum, and
says to set a positive decimal integer in the environment that starts REA and
then restart REA. There is no runtime override. Setup forwards an explicit
selection. When the poll budget runs out, admission keeps the last observation
instead of failing the readable file. Raising a setting only changes how long
that wait can last. It does not change Windows ChangeTime itself.

A per-call budget can have a runtime default without having an environment
setting. JavaScript `max_heap_mb`
(CLI `--max-heap-mb`) is an integer from 128 to 16384 MiB, default 1024. It
applies on the next analysis, which starts a new worker, and does not restart
REA. It does not raise the parent result budget, transfer ceilings, or fixed
parser limits.

Host memory and `NODE_OPTIONS` do not raise a REA admission unless that
admission's recovery says so. The JavaScript parent result budget is one that
does: its recovery says to set `NODE_OPTIONS` (for example
`--max-old-space-size=<MiB>`) on the process that starts REA, then restart
that process. `max_heap_mb` does not raise it.

## Runtime settings through MCP

`inspect_analysis_settings` lists the curated settings, their current and launch
values, source, bounds, application point and relevant operation names. Filters
by exact setting IDs, provider or operation intersect. Active worker values are explicitly `not_observed`; a configured default is
not a measurement of active work. Inspection also separates known server limits from unknown client deadlines and receive buffers.

`update_analysis_settings` accepts an atomic `changes` array. Each entry names
an exact `setting` and either `action: "set"` with a schema-validated `value`, or
`action: "reset"`. Reset restores the launch value. `expected_revision` is an
optional compare-and-set guard; conflicts and duplicate keys change nothing.
An unchanged write does not advance the revision.

The revision tracks override state, not only effective numeric values. Setting
an explicit override equal to the launch value still changes its source to
`runtime` and advances the revision. Reset removes that override, even if the
effective number stays the same. Validation, revision checks, and duplicate-key
checks all happen before publishing the replacement snapshot; a rejected batch
cannot partially apply. Clients coordinating writes can supply
`expected_revision`; without it, valid updates apply to the current state.

| Runtime setting                                                                                                 | Application point                                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `asar.max_header_bytes`                                                                                         | Next archive operation, including full JavaScript application analysis          |
| `asar.max_listing_bytes`                                                                                        | Next expanded ASAR listing, independently of packed header bytes                |
| `ghidra.startup_timeout_ms`, `hopper.startup_timeout_ms`                                                        | Next provider startup attempt                                                   |
| `ghidra.decompile_timeout_seconds`                                                                              | Next operation on the existing Ghidra Program; `null` means unbounded           |
| `ghidra.decompile_max_payload_mib`                                                                              | Next native decompile; `null` preserves the selected provider's payload default |
| `ghidra.value_flow_max_operations`, `ghidra.value_flow_max_inputs_per_operation`, `ghidra.value_flow_max_edges` | Next function value-flow projection on the existing Program                     |
| `jadx.operation_timeout_ms`                                                                                     | Next JADX operation                                                             |
| `regex.matching_deadline_ms`, `regex.worker_heap_request_mib`                                                   | Next search / new regex worker                                                  |
| `capture.decoder_old_generation_mib`                                                                            | Next owned capture decoder                                                      |
| `javascript.analysis_timeout_ms`, `javascript.max_heap_mb`                                                      | Next source analysis / new JavaScript worker                                    |
| `wasm.command_timeout_ms`                                                                                       | Next WABT operation                                                             |
| `native.matching_representation_bytes`                                                                          | Next `match_native_functions` request                                           |

### Precedence and lifetime

Where a setting supports an explicit per-call argument, precedence is:

1. The caller's explicit argument.
2. The accepted operation's runtime override.
3. Valid launch configuration, where that setting has an environment seed.
4. The built-in default when launch configuration is absent.

An invalid launch value does not fall through to the built-in default. Preserve
omitted caller arguments in Evidence: resolving an internal default must not
rewrite the request as though the caller supplied it. `null` is the explicit
unbounded value for `ghidra.decompile_timeout_seconds`; it is not a substitute
for an unknown or omitted value elsewhere.

A write does not extend active work, relaunch a provider, clear retained
cleanup, or invalidate successful Evidence.

Expanded ASAR listing admission defaults to 64 MiB and has its own launch seed,
`REA_ASAR_MAX_LISTING_BYTES`. Raising `asar.max_header_bytes` alone cannot admit
expanded paths and entries that exceed this separate budget. The listing bound
uses exact safe-integer byte accounting; the host heap and transport constraints
remain independent. A lower runtime value is enforced on the next listing even
when the archive header was already examined.

Ghidra value-flow controls default to 3,000 operations, 64 inputs per operation,
and 12,000 edges. They accept positive Java integer counts and use the respective
`REA_GHIDRA_VALUE_FLOW_MAX_OPERATIONS`,
`REA_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION`, and
`REA_GHIDRA_VALUE_FLOW_MAX_EDGES` launch seeds. Truncation names the exhausted
control. Completed Evidence remains accessible, but a new function dossier is
observed with the accepted controls instead of replaying an earlier projection.

The native decompiler payload control is separate from those projections and
from decompile time. Its launch seed is
`REA_GHIDRA_DECOMPILE_MAX_PAYLOAD_MIB`. Accepted explicit values are 1..2047 MiB:
the supported Ghidra implementation shifts that value into a signed integer byte
capacity. Omission or runtime `null` keeps the provider's own default; REA does
not guess that default from a different provider version. Changing payload
options takes effect before the next native decompile.

### Per-call resource policies and selection

An agent can also use controls declared directly by an operation. These do not
require a runtime setter or restart. Keep omitted fields omitted in Evidence;
report the resolved policy separately where needed. See the owning guides for
[Apktool string pages](../guides/android/apktool-resource-analysis.md),
[source maps](../guides/web/web-source-location.md),
[historical captures](../guides/web/web-network-captures.md),
[JavaScript precision](../guides/javascript/javascript-application-graph.md),
[managed inspection](../guides/managed/managed-code-analysis.md), and
[Frida capture](../guides/runtime/frida-instrumentation.md).

The same accepted policy must reach acquisition, parsing, worker requests,
serialization, cached-result admission and generated consumers where those
stages exist. Desktop state views and emitted AgentEnv Python share one policy;
delivery pagination never substitutes for producer selection. Capture limits
must be selected before an experiment: another experiment cannot recover bytes
that were dropped from a previous live observation.

Overrides belong to one REA runtime, survive target close/open, and disappear
when REA exits. Connections sharing that runtime share its overrides. No files,
ambient environment, registrations or upstream software are edited. Overrides
are runtime-wide, not scoped to a target or an individual connection.

### Failure and retry

An ASAR admission error supplies `details.limit` with the exact setting,
effective value, units, bounds, scope, application point, `update_mode`,
`pending_restart` and, when known, required bytes and value source. The agent can immediately call:

```json
{
  "changes": [
    { "setting": "asar.max_header_bytes", "action": "set", "value": 33554432 }
  ]
}
```

Then retry the same full-archive request once work and cleanup have settled.
No preliminary inspection or source subset is required. The setter does not
retry automatically. If an explicit per-call value caused the failure, correct
that argument; raising a runtime default cannot override it.

The resource owner constructs `details.limit` from the registry plus the budget
it actually enforced. Metadata includes `agent_editable: true`,
`scope: "rea-runtime"`, `update_mode`, and `pending_restart`. `update_mode`
is `runtime` when `update_analysis_settings` can change the active value,
`restart` when this process keeps the value it started with, and `parameter`
when this call supplied the value. An explicit `analysis_timeout_ms`,
`max_heap_mb`, or `command_timeout_ms`, plus artifact reader limits and
web-network capture budgets, use `parameter`. `pending_restart` is false when
that reported value is the one this process is using. Optional
`required_value`, `source`, and `parameter` fields are supplied only where known
or applicable. Do not infer a source because a value happens to equal a default.
Error copying, attribution, redaction, and delivery must preserve these facts.
Human-readable remediation explains the same failure; clients should not need
to parse that sentence to identify an editable setting.

This output is breaking. Results and errors no longer carry the previous
restart boolean or a single effect field, and there is no compatibility alias.
Read `update_mode` to see whether the setter can change the active value, and
`pending_restart` to see whether a configured value is waiting. A configuration
error for a Windows ChangeTime setting carries those two fields on
`details.settings`, not only in the constraint sentence. The removed field names
are listed in the changelog.

`scope` and `applies_at` describe a continuing caller, such as an MCP
connection. A one-shot invocation, such as a CLI command, has released its
provider session and exited its runtime before its caller reads the failure,
so its adapter projects with an explicit `"invocation"` caller lifetime.
`details.limit` then keeps every other field and reports
`scope: "rea-invocation"`, `applies_at: "next_invocation"` and the launch
`environment` seed when one exists. `agent_editable: true` still holds, because
the caller chooses that environment value or per-call `parameter` for the new
invocation; `update_mode: "runtime"` and `pending_restart: false` mean the
reported value is active in this process. `update_mode: "restart"` means
`update_analysis_settings` does not change it. `update_mode: "parameter"` means
this call supplied the value. A producer keeps guidance that holds only while its caller retains the
session, such as "the Ghidra session remains usable" or a same-session runtime
update, in `continuingCallerGuidance`; the shared presentation adds it only for
a continuing caller. The producer's own message and remediation must stay true
after the session is released. A composed error records each embedded child
failure through `childFailureDiagnostics`, which snapshots it at composition
for both lifetimes when they differ, so cleanup history keeps its state and
the final projection selects the caller's form. Failures retained inside
Evidence keep the continuing form, so CLI and MCP Evidence stay identical.

Cache policy is part of enforcement. Successful reusable analysis can survive
a budget update. Transient Ghidra decompile failures remain uncached so a raised
deadline can recover on the same Program. Admission checks still apply to reused
data: lowering an ASAR limit must reject a cached oversized header. Neither
raising a limit nor clearing a transient analysis failure authorizes skipping
cleanup or changing the identity of the provider session.

### Invalid launch configuration

Launch validation has two relevant boundaries. Settings validated by global
configuration parsing can prevent REA from starting; an MCP setter cannot
repair a server that is not running. Correct the launch environment or
registration, use `rea doctor` for its configuration checks, and start REA again.

Provider-local validation can leave MCP available. For example, an invalid
`REA_JADX_OPERATION_TIMEOUT_MS` is inspectable with `source: "invalid"`, a
`configuration_error`, and omitted `value` and `launch_value`. A valid runtime
override repairs the effective JADX timeout without editing that launch seed.
Inspection then reports the runtime value while retaining the launch error.
Reset exposes the invalid launch state again; it does not repair or replace it
with the built-in default. Provider availability and execution must resolve the
same effective setting so readiness changes along with repair and reset.
`REA_NATIVE_MATCHING_REPRESENTATION_BYTES` is validated the same way, by
`match_native_functions` alone.

## Keep a fixed ceiling honest

Inspection's separate
[constraints](https://github.com/morluto/rea/blob/main/src/server/analysisSettingsConstraints.ts)
describe operator-owned, external, and fixed controls. REA can report its
configured response budget and parent heap limit; client deadlines and receive
buffers remain explicitly unknown. These are not entries accepted by the
runtime setter. Raising a worker heap request cannot raise the parent heap,
and raising a provider deadline cannot make the client wait longer.

If the ceiling must stay fixed, say so in the failure. Name the limit and the
effective value, say this release has no runtime override, and name what does
not raise it. Do not invent a setting.

JSON values stop at `MAX_JSON_DEPTH` (1000) in
[`jsonValue.ts`](https://github.com/morluto/rea/blob/main/src/domain/jsonValue.ts):
"JSON value exceeds maximum nesting depth of 1000. This release has no runtime
override."

## Recovery text

The string the caller sees includes:

- the limit or setting name
- the effective value and unit
- the source when known (`default`, `setting`, `runtime`, or `request`)
- the default, the maximum, and the floor when the setting has one
- the next action, including where to set it ("in the environment that starts REA")
- whether a restart is required
- what the change does not raise

Distinguish an invalid configuration from a valid budget exhausted by work.
Preserve the configuration failure and its setting identity; apply the
[launch validation boundary](#invalid-launch-configuration) when describing
whether live repair is possible.

## What agents do

Use `details.limit` for a direct runtime update when it names an editable
setting with `scope: "rea-runtime"`. For `scope: "rea-invocation"`, set its
`environment` or `parameter` for a new invocation instead.
Follow `remediation.action` for per-call, fixed and external controls.
Inspect settings only when bounds or application details are missing. Restart only when it says the value is
read at startup. A sentence that a control does not raise the limit is not a
request to change it.

- Dropped MCP connection: retry the call once only when it is safe to repeat
  or known not to have started. If it may already have changed the target, or
  it fails again, tell the user and ask them to restart the MCP client. Do not
  start with `rea doctor`
  ([#6353](https://github.com/morluto/rea/pull/6353)).
- REA could not start its connection: retry once. If it fails again, tell the
  user and ask them to restart the MCP client, then run `rea doctor`. Do not
  retry a startup that returns the same unchanged result: tell the user REA
  could not start, ask them to restart the MCP client, then run `rea doctor`.
- Unexpected process-command failure: do not repeat the command. Tell the user
  to check the input files, then run `rea doctor`.
- `cleanup_incomplete`: the operation is not retryable. Retry that exact
  cleanup owner, named in `details.resources`, and wait until it confirms
  release before admitting new work on those resources
  ([#6357](https://github.com/morluto/rea/pull/6357)).
- `resource_constraint` for capacity, when `retryable` is true: wait for the
  active admission to finish, then retry within the reported limits. Do not
  restart REA to free the slot.
- `configuration_invalid`: when MCP remains available and the failure belongs
  to a curated provider-local setting, inspect and set a valid runtime override.
  Otherwise correct the named setting in the environment that starts REA, then
  start REA again. Run `rea doctor` for the
  `runtime-configuration:` check. Re-run `rea setup` for that client when the
  setting is on the registration allowlist, then reconnect so the new process
  sees it.
- `invalid_request`: follow the specific recovery and reported issue. Inspect
  the schema or CLI help when the input violates the contract or the response
  asks for `inspect_input_contract`. A valid selector can instead require a
  different choice, such as selecting a reported address; an inventory miss
  does not establish that the target lacks the item. Do not repeat the
  unchanged call when the response says it cannot succeed unchanged.

A restart is required to adopt a changed launch environment or registration.
The curated runtime settings above require no REA restart. It is not the first step for a transient
MCP drop, a capacity wait, or retained cleanup.

## Adding a runtime setting

1. Identify the enforcing owner and the real resource constraint. Decide whether
   callers need a per-call argument, a runtime default, a launch-only control,
   or a fixed limit. A registry entry must not advertise authority REA lacks.
2. Define the value type and named numeric bounds with the domain owner. Add the
   ID and metadata to `analysisSettings.ts` and `analysisSettingDefinitions.ts`.
   Reuse those bounds in runtime validation, launch parsing, and error metadata.
   Choose the application point and provider/operation associations from actual
   consumers; a shared control need not apply to every provider.
3. If there is a launch seed, add its parser and appropriate configuration/doctor
   validation. Decide whether an invalid value blocks the runtime or only the
   provider. Add it to setup's `SELECTED_REGISTRATION_SETTINGS` when it should
   be forwarded; runtime editability does not automatically propagate it.
4. Thread the shared reader through every applicable composition path. Resolve
   the effective value within the accepted operation, honor explicit arguments,
   and preserve their omission in Evidence. Keep availability checks consistent
   with execution. A worker heap request must not be described as a measured
   process memory limit.
5. Enforce the value at its resource boundary and construct structured limit
   facts there. Preserve those facts through shared error projection and copies.
   Check cache reuse, lowered admission, transient failures, and retained cleanup
   against the same ownership rules.
6. Update the public contracts and affected guides, then regenerate catalogs
   and packaged skill metadata using the repository commands. Keep externally
   owned and fixed controls in the separate inspection constraints, not in the
   editable registry. Validate both store semantics and a public recovery path.

## Tests and verification

Cover the unset default, accepted overrides, rejected floor/maximum values,
and invalid syntax through the owning parser and configuration boundary.
[`regexMatchingDeadline.test.ts`](https://github.com/morluto/rea/blob/main/src/config/regexMatchingDeadline.test.ts)
is one example. Assert error codes, setting IDs, values, units, provenance,
application points, and resulting behavior. Check that adapters deliver the
canonical recovery guidance, with independent assertions for its underlying
facts. Avoid freezing prose or deriving all expected values from the same
registry used by the implementation; either can hide the wrong failure.
See [test design](../development/testing.md#test-design-and-pruning) for the assertion policy.

Runtime checks cover atomic validation, stale writes, reset, runtime isolation,
accepted-operation snapshots, and explicit argument precedence. Public MCP
acceptance must reject an oversized ASAR, raise admission, and successfully
retry the same complete archive on the same connection. Lowering admission must
also refuse previously cached headers. The real Ghidra timeout verifier checks
recovery after a live update without replacing its session. Also cover invalid
provider-local launch configuration, repair/reset availability, default and
custom composition paths, and preservation of structured limits through error
copies. Gates used to overlap work and updates need bounded acknowledgements
and release/join in `finally`.

The [verification report](../verification/runtime-analysis-settings.md) separates
public MCP checks, simulated provider coverage, real Ghidra execution, and
measured task costs. It does not establish real-provider behavior for every
editable setting or active worker telemetry.

## Bun standalone module graphs

`inspect_artifact` and `extract_artifact` accept per-call `artifact_limits`.
The `bun` group defaults to 100,000 modules, independent 256 MiB payload,
retained-representation and physical metadata-read allowances, 256 path parts
and 250,000 logical path nodes. Recognition separately admits a 1 MiB ELF
section table and 16 MiB Mach-O load commands. Exhausted recognition remains
unknown rather than proving the carrier has no Bun graph. Inventory preserves
native-root facts or another confirmed pack and reports the exact unexamined
alternative inline; it does not assert Bun presence. ELF section names
are examined with exact bounded reads, including names beyond the former
prefix window.

For example, keep the same complete carrier and retry a reported recognition
limitation with `{"artifact_limits":{"bun":{"recognition_table_bytes":2097152}}}`.
The CLI spelling is `--artifact-limits '{"bun":{"recognition_table_bytes":2097152}}'`.
No REA restart is needed. A smaller later selection is re-admitted; previously
parsed facts cannot bypass it. The 256 KiB / 1,024-entry exact-range cache
avoids full-page amplification and remains an internal optimization, not an agent
resource setting. Shared logical path prefixes count once before nodes are added.

## Artifact reader admission

The same request provides `dotnet_bundle`, `node_sea` and `godot` groups. Their
controls apply when recognition or inventory encounters that format; supplying
a policy does not assert the format is present. Unsupported keys are rejected.
Each group follows one domain-owned default policy. See [.NET bundles](../dotnet-bundles.md),
[Node SEA](../node-sea.md), [Godot PCK](../godot-pck.md) and
[Bun standalone](../bun-standalone.md) for format semantics.

`artifact_limits.expanded_bytes` selects aggregate plaintext work for ZIP, Bun,
SEA and PCK readers, including repeated readable logical occurrences. Omission
retains each archive's encoded-size-derived default. The .NET bundle group's
own `expanded_bytes` controls its independently enforced bundle expansion.

Failures preserve `details.reader_limit` with the exact parameter, effective
value, units, supported range, required value when known, next-call scope and
`can_increase`. `update_mode` is `parameter`: the caller selects the value on
the next call, and `update_analysis_settings` does not accept it.
`pending_restart` is false. Web-network capture budgets use the same mode.
When `can_increase` is true, raise that field and retry the same
complete artifact. At the supported maximum, or when the required representation
exceeds it, the failure is not retryable by increasing that budget; inspect the
declared dimensions and input validity, or explicitly choose a suitable reader.
Summary, pagination and
selected extraction do not bypass producing admission. Intrinsic format,
safe-integer, path validity and runtime representation constraints remain fixed.

Evidence parameters retain the exact selected object, including omission or
`{}`. When an object was selected, inventory and extraction report the resolved
`effective_limits`; summaries preserve those facts. These are accepted policies,
not process-memory telemetry or a claim that every format reader ran. Complete
source identities and graph manifests remain content-addressed independently
of delivery selection. No partial extraction is claimed on admission failure.

## Deno compile sections

`MAX_DENO_METADATA_JSON_BYTES` admits at most 8 MiB of metadata JSON.
`MAX_DENO_VFS_HEADER_JSON_BYTES` admits at most 32 MiB of virtual-filesystem
header JSON. Specifier, redirect, and remote tables each admit at most 100,000
records. Specifier text admits at most 8 MiB, and remote module bodies admit at
most 256 MiB. The virtual filesystem admits at most 100,000 directory, file,
and symlink records and at most 512 nested levels (`MAX_DENO_VFS_DEPTH`). A
name longer than 4,096 UTF-16 code units is indexed and is not retained.
`MAX_DENO_VFS_RETAINED_UNITS` admits at most 32 million UTF-16 code units across
the source path built for every entry, directories included, and retained
symlink parts. A logical path deeper than 256 parts, a name that is not a safe
relative path, a path component longer than 255 UTF-8 bytes
(`MAX_DENO_PATH_COMPONENT_BYTES`, POSIX `NAME_MAX`), or a logical path longer
than 512 UTF-8 bytes (`MAX_DENO_LOGICAL_PATH_BYTES`, half of the Darwin
`PATH_MAX`) uses an indexed path and keeps the original spelling when that
spelling is within the name allowance. Component and path lengths include the
`.deno-*` suffix of the stored regions a member has. A descendant has no source
path when an ancestor spelling was not retained. Cancellation is checked before
the virtual-filesystem walk. The walk does not yield, so it does not observe a
cancellation that arrives while it is running; the retained allowance bounds its
work. The combined logical path tree admits at most 250,000 distinct prefixes.
`MAX_DENO_RETAINED_BYTES` admits at most 256 MiB of retained header and entry
metadata. The shared artifact expansion budget also bounds the sum of referenced
member lengths, with a 256 MiB floor.

Carrier location claims a file only after it confirms the carrier name: a
Mach-O `__SUI` segment, a `SUI` ELF note descriptor named `d3n0l4nd`, a PE
`D3N0L4ND` resource, or an Intel trailer opening with `d3n0l4nd`. Before that,
malformed tables and exhausted search budgets leave the file with native
inventory, and that inventory makes no claim that the file holds no Deno
section. ELF location reads ELF and note headers, not the whole image, and does
not hash note descriptors. An ELF larger than 512 MiB is still located when
those headers fit. Program and section tables are read at their canonical record
size, so the 16-bit header count bounds each read at 65,535 records. A table
that cannot be read, or that uses extended program numbering, is skipped and
another table can still hold the note. At most 256 notes are examined
(`MAX_INSPECT_ELF_NOTE_ENTRIES`). A damaged table or the note ceiling is a
refusal only when a `SUI` note was also confirmed. Intel Mach-O trailer search
reads each scanned byte at most once and examines at most 64 `<~sui-data~>`
sentinels (`MAX_DENO_INTEL_TRAILER_SENTINELS`). The search continues past a
confirmed trailer, because an enclosing trailer can hold it as a stored file, so
reaching that allowance after a confirmation is a refusal. PE location walks the resource directories to the named payload and
does not read the image whole, so a PE of any size is located when the
`D3N0L4ND` payload is within the 512 MiB resource reader ceiling. A larger
payload, or a confirmed resource that cannot be resolved, is a named refusal.
Refusals name the boundary. There is no runtime override; additional host memory
or `NODE_OPTIONS` does not raise these ceilings. Duplicate-section verification
rejects unequal lengths before hashing, stops at the first digest mismatch,
and reads at most the carrier file size in aggregate
payload bytes. Overlapping copies that exceed that allowance are refused.
Environment-file values and CA certificate bytes are retained in local Evidence
with their counts and byte lengths. The npm snapshot length is retained and its
bytes are not decoded.
