# Analysis settings, limits, and recovery

Use this guide to inspect and change REA analysis budgets, and to recover from
a resource limit. See the [MCP contracts](mcp-contracts.md#editable-analysis-settings),
the [limit inventory](rea-limit-inventory.md), and the
[verification report](../verification/runtime-analysis-settings.md).

## Runtime settings through MCP

`inspect_analysis_settings` lists the curated settings, their current and launch
values, source, bounds, application point and relevant operation names. Filters
by exact setting IDs, provider or operation intersect. Inspection marks active
worker values as `not_observed` and distinguishes known server limits from
unknown client deadlines and receive buffers.

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
[managed inspection](../guides/managed/managed-code-analysis.md),
[ADB listings](../guides/android/adb-device-analysis.md),
[Android class search](../guides/android/android-analysis.md), and
[Frida capture](../guides/runtime/frida-instrumentation.md).

ADB package, process, directory, feature, and service listings apply `limit`
and `offset` after capturing the listing. The [ADB guide](../guides/android/adb-device-analysis.md#interpret-the-result)
describes coverage and how to continue.

Graph tools accept per-call traversal bounds (`max_depth` and `max_nodes` on
`get_call_graph` and `trace_call_path`).

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
when the budget is adjustable through a per-call argument. Its `source` records
whether the reported value came from a request or a default. An explicit `analysis_timeout_ms`,
`max_heap_mb`, or `command_timeout_ms`, plus artifact reader limits and
web-network capture budgets, use `parameter`. `pending_restart` is false when
that reported value is the one this process is using. Optional
`required_value`, `source`, and `parameter` fields are supplied only where known
or applicable. Do not infer a source because a value happens to equal a default.
Error copying, attribution, redaction, and delivery must preserve these facts.
Human-readable remediation explains the same failure; clients should not need
to parse that sentence to identify an editable setting.

A deadline controlled by something other than a registered setting reports
`details.limit` with `control_kind` instead of `setting`.
`control_kind: "parameter"` names the per-call contract field in `parameter`
(`native_command_timeout_ms`, `native_ui_deadline_ms`,
`pwntools_timeout_ms`) and applies on the next call. Services and their
remediation text name only that field. A CLI command adds `cli_flag`, the
option that sets the field on that command, from its own field-to-flag
binding; MCP results do not carry it.
A completed or partial result can record the same reference, for example a
`limit` in a web bundle `unknowns` entry for a script that reached its
`analysis_timeout_ms` deadline. That reference is part of the result and its
Evidence identity, so the CLI never adds to it. Instead, the CLI renders the
flags in its own `--full-output` envelope as `meta.cli_controls`, a map from
each recorded contract field to the option that sets it on that command. The
bare result is the record itself and gains no CLI field.
`control_kind: "environment"` names the `environment` variable REA reads when
it starts (`REA_SWIFTC_COMPILE_TIMEOUT_MS`): `applies_at` is `next_startup`,
or `next_invocation` for a one-shot invocation. Both carry `effective_value`,
`unit`, `minimum`, `maximum` and `default_value`. `update_analysis_settings`
changes neither. A limit without `control_kind` is a registered setting.

This output is breaking. Results and errors no longer carry the previous
restart boolean or a single effect field, and there is no compatibility alias.
Read `update_mode` to see whether the setter can change the active value, and
`pending_restart` to see whether a configured value is waiting. A configuration
error for a Windows ChangeTime setting carries `update_mode` on
`details.settings`. Its rejected value does not establish an accepted pending
configuration, so `pending_restart` is omitted. The removed field names
are listed in the changelog.

An inspected setting whose launch value is invalid and which has no runtime
override likewise omits `pending_restart`: it has no accepted configured value
to classify. Setting a valid runtime override reports `pending_restart: false`;
resetting it restores the invalid launch state and the omission.

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
the budget is adjustable through a per-call argument; `source` identifies where
the reported value came from. A producer keeps guidance that holds only while its caller retains the
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

A fixed ceiling is the exception. Keep one only for a stated format, protocol,
or representation reason.

Inspection's separate
[constraints](https://github.com/morluto/rea/blob/main/src/server/analysisSettingsConstraints.ts)
describe operator-owned, external, and fixed controls. REA can report its
configured response budget and parent heap limit; client deadlines and receive
buffers remain explicitly unknown. These are not entries accepted by the
runtime setter. Raising a worker heap request cannot raise the parent heap,
and raising a provider deadline cannot make the client wait longer.

The failure names the limit and the effective value. Say this release has no
runtime override, and name what does not raise it. Do not invent a setting.

JSON values stop at `MAX_JSON_DEPTH` (1000) in
[`jsonValue.ts`](https://github.com/morluto/rea/blob/main/src/domain/jsonValue.ts):
"JSON value exceeds maximum nesting depth of 1000. This release has no runtime
override."

## Typed refusals

A producer that refuses a request types the refusal instead of leaving
recovery to the resource kind. The domain owner is
[`analysisRefusal.ts`](https://github.com/morluto/rea/blob/main/src/domain/analysisRefusal.ts).
It has three variants. Each one projects under `details.refusal` with the
`operation` the error is attributed to:

| Variant              | Producer fact                                                                                                                            | Projected fields                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `fixed_ceiling`      | `fixedAllowanceOptions(name, kind, { limit, unit, narrowing })`, or an artifact reader's `artifactFixedLimitFailure(allowance, outcome)` | `allowance`, `allowance_kind`, `limit`, `unit`, `narrowing`                         |
| `adjustable_budget`  | an `AnalysisSettingLimit` bound as `limit`                                                                                               | `control`, `setting`, `effective_value`, `unit`, `range`, optional `required_value` |
| `ambiguous_selector` | `AnalysisInputError` option `ambiguousSelector: { field, candidates }`                                                                   | `field`, `candidates`                                                               |

Presentation is total over these variants. Authored remediation still wins.
Without it, the variant names the recovery: fixed ceilings and their narrowing
step, the budget's control and range for the caller's lifetime, or the selector
field and its candidates. A resource refusal never falls back to text about
worker limits, the MCP transport, or doctor. An ambiguous selector conforms to
the input contract, so it does not ask the caller to inspect the schema.

A measured exhaustion or occupied admission is not a refusal. It declares
`measuredExhaustion: true` and keeps the resource kind's recovery. The
`rea/typed-resource-refusal` lint rule rejects a new
`AnalysisResourceConstraintError` that names none of these. Older untyped
constructions are counted in
`scripts/lint/rules/typed-resource-refusal-baseline.json`, and those counts may
only shrink.

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
  the reported reason and ask them to check the scenario or capture files it
  read; if they are valid, report the failure with its diagnostics. Doctor does
  not check process commands.
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

1. Identify the enforcing owner and the real resource constraint. A hardcoded
   limit becomes an `REA_` runtime setting with a default, a floor, and a
   maximum. Its errors name the setting, the effective value, the source, and
   the range. A fixed ceiling is the exception and needs a stated format,
   protocol, or representation reason; that error names the limit and the
   effective value. A registry entry must not advertise authority REA lacks.
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

## Artifact reader admission

`inspect_artifact` and `extract_artifact` accept `dotnet_bundle`, `node_sea`
and `godot` groups in `artifact_limits`. Their controls apply when recognition
or inventory encounters that format; supplying
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
