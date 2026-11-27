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

Frida process discovery applies `limit` and `offset` after enumerating the
selected device. It reports `total_processes` and `truncated`. Moving to another
page runs a fresh discovery on that device.

`inspect_gpu_code_objects` accepts per-call budgets `max_object_bytes` (default
and maximum 128 MiB), `max_work_bytes` (default and maximum 512 MiB, covering
payload input, decoded output, native-section reads, and AMDGPU note/structure
reads), `max_report_bytes` (default and maximum 16 MiB), `max_metadata_bytes`
(default and maximum 8 MiB), `max_structure_bytes` (default 16 MiB, up to
512 MiB), `max_parser_entries` (default and maximum 65,536),
`max_parser_visits` (default and maximum 262,144), and `max_token_bytes`
(default and maximum 65,536). Top-level refusals report `details.limit`
(`control_kind: "parameter"`), per-object payload/metadata/visit limits retain
sibling observations with `inspection: "capacity"` naming the budget, and
recursive container/AMDGPU MessagePack nesting caps and the 128-token PTX
single-parameter syntax limit remain fixed ceilings; see
[GPU code objects](../gpu-code-objects.md#work-and-limits).

Graph tools accept per-call traversal bounds (`max_depth` and `max_nodes` on
`get_call_graph` and `trace_call_path`).

`inspect_elf_notes` and `inspect_elf_debug_link` refuse a file above
`max_file_bytes`, a decoded section-name table above it, or more notes than
`max_entries` with `details.limit` naming that field
(`control_kind: "parameter"`), its effective value, default and range. `inspect_il2cpp_metadata`
accepts `max_native_index_bytes` (default 1 GiB) for the estimated ELF pointer
index of `binary_path`; its refusal reports the same kind of limit. See
[IL2CPP metadata](../il2cpp-metadata.md#native-method-addresses).

`inspect_devicetree`, `inspect_windows_shortcut`, `inspect_kernel_build_config`,
`extract_firmware` and `inspect_byte_entropy` report the same parameter limit for
their per-call budgets (`max_file_bytes`, entry, depth and decoded-byte budgets,
`max_output_bytes`/`max_output_files`, and `block_size` or `length`).
`inspect_devicetree` bounds its estimated decoded representation with
`max_decoded_bytes` (default 32 MiB, at most 256 MiB).
`inspect_elf_dependencies`, `inspect_elf_unwind_ranges`, `inspect_macho_function_starts`,
`inspect_apple_ips`,
`inspect_dwarf_units`, `inspect_native_initializers`, `inspect_pe_overlay`,
`inspect_pe_resources` (`max_entries`), `inspect_api_contract` (`max_file_bytes`),
`compare_wasm_interfaces` (`max_interface_bytes`),
`trace_web_source_location` (`source_map_limits.*`),
`inspect_v8_code_cache` (`max_file_bytes`, `max_strings`) and
`inspect_erlang_beam` report it too. The per-page symbol-name text allowance of `inspect_elf_unwind_ranges` is a fixed allowance (`details.refusal.kind` `fixed_ceiling`); its `narrowing` asks for a smaller page `limit` or paging with `offset`. `inspect_erlang_beam` accepts `max_table_rows` (export,
import and lambda rows combined; default 65,536, at most 1,048,576).

### Native table structure budget

`inspect_elf_unwind_ranges`, `inspect_macho_function_starts`, `inspect_kernel_module`, `inspect_elf_debug_link`,
`inspect_dwarf_units`, `inspect_binary_hardening`, `inspect_native_initializers`,
`inspect_gpu_code_objects` and `inspect_native_exports` accept `max_structure_bytes` (CLI
`--max-structure-bytes`, 64 bytes to 512 MiB, default 16 MiB). It bounds one
header, section, load-command or ELF dynamic-directory table read, and,
separately, the section names decoded from the section-name table, before the
decoded records are allocated. A refusal is a `memory` resource constraint
whose `details.limit` names `max_structure_bytes`, its effective value, range
and default; `details.reported_limits.boundary` is `max_structure_bytes`.
`max_file_bytes` does not raise it. `inspect_elf_debug_link` still counts
decoded section names against `max_file_bytes` as well. For `inspect_binary_hardening` it
covers the ELF header tables, section names and dynamic table; Mach-O load
commands keep the Mach-O command reader's own limit, and the PE headers it reads
are bounded by the PE format.

For `inspect_native_exports` it also bounds the ELF dynamic, symbol and version
tables located through PT_DYNAMIC. For `inspect_native_initializers` it also
bounds Android APS2 packed relocation tables (both compressed input bytes and
equivalent unpacked REL/RELA work).

`inspect_go_binary` and `inspect_rust_binary` accept it for their ELF directory
and Mach-O load commands. The IL2CPP reader reads the same tables with the 16
MiB default and reports it as a fixed allowance.

`inspect_rust_binary` also accepts `max_wasm_sections` (WebAssembly sections
walked; default 65,536, at most 16,777,216). The walk stops at the first excess,
so the refusal reports no `required_value`.

`inspect_native_exports` also accepts `max_entries` (export rows and declared
symbol counts; default 262,144, at most 4,194,304) and `max_text_bytes` (name and
version text retained across rows; default 16 MiB, at most 256 MiB). A table
whose declared count exceeds `max_entries` reports that count as
`required_value`; the text budget stops at the first excess and reports no
`required_value`.

### Static reader read allowance

`inspect_pe_imports`, `inspect_pe_resources`, `inspect_pe_load_config`,
`inspect_pe_certificates`, `inspect_pe_unwind_ranges`, `inspect_macho_function_starts`,
`inspect_binary_hardening` and
`inspect_native_exports` bound the bytes they read, not the file size.
`max_file_bytes` (CLI `--max-file-bytes`) counts each positional read of
headers, directory tables and the ranges they reference. Defaults are 64 MiB
(256 MiB for exports), with a floor of 64 bytes and a maximum of 512 MiB. The
one streaming pass that hashes the file for its identity is not counted.

An exhausted allowance is a `capacity` refusal. `details.limit` has
`control_kind: "parameter"`, `parameter: "max_file_bytes"`, the effective
value, the bounds, the default and `applies_at: "next_call"`, and
`details.reported_limits.required_read_bytes` holds the reads needed so far.
It is a lower bound, since later reads depend on structures not yet decoded, so
the limit reports no `required_value`. Raise `max_file_bytes` and retry;
`update_analysis_settings` does not change it.
The identity pass has a fixed whole-file ceiling: 4 GiB minus one byte for the
PE readers and `inspect_macho_function_starts` (their file offsets are 32-bit),
and 512 MiB for hardening and exports. A file above it is a `file-size`
refusal naming that fixed allowance, which `max_file_bytes` does not raise.

Those readers also report `details.limit` for their per-call inventory budgets:
`inspect_pe_imports` `max_dlls`, `max_functions` and `max_text_bytes` (decoded
names, default 16 MiB, at most 256 MiB); `inspect_pe_load_config`
`max_callbacks`; `inspect_pe_unwind_ranges` `max_entries` (default 2,097,152, at
most 16,777,216; the declared count is its `required_value`);
`inspect_macho_function_starts` `max_entries` (default 2,097,152, at most
16,777,216; the combined start and data-in-code count is its `required_value`);
and
`inspect_pe_resources` `max_entries` and `max_metadata_bytes` (the complete
result, default 8 MiB, at most 256 MiB).

### Producer limits

Operations with an owned producer accept an optional
`producer_limits` object (CLI `--producer-limits`, as JSON text). Each field is
a positive safe integer that overrides one default for this call only; omitted
fields keep their defaults, and no restart is needed. Tighter inherited OS
limits still apply, and these fields do not raise parser, protocol or transport
limits. Each operation accepts only the fields it enforces; any other key is
rejected.

| Field                 | Bounds                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `input_bytes`         | The selected input copied for the producer                                                                                           |
| `output_bytes`        | Retained producer output: combined stdout and stderr where no `diagnostic_bytes` is offered; the reply file for pwntools and EVM     |
| `diagnostic_bytes`    | Retained process diagnostics; for pwntools, stdout and stderr combined. A stdout overflow is raised here, not through `output_bytes` |
| `command_timeout_ms`  | Wall-clock deadline for each owned command                                                                                           |
| `address_space_bytes` | The producer's address-space ceiling                                                                                                 |
| `file_bytes`          | The largest file the producer may write                                                                                              |
| `cpu_seconds`         | The producer's CPU time                                                                                                              |

| Operations                                                   | Fields and defaults                                                                                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_packet_capture`, `decode_signal_recording`          | `input_bytes` 32 MiB, `output_bytes` 4 MiB, `command_timeout_ms` 30000, `address_space_bytes` 1 GiB, `file_bytes` 64 MiB, `cpu_seconds` 30                                                    |
| `inspect_packet_fields`                                      | No `input_bytes`; `output_bytes` 32 MiB, `command_timeout_ms` 30000, `address_space_bytes` 1 GiB, `file_bytes` 64 MiB, `cpu_seconds` 30                                                       |
| `inspect_signal_decoders`                                    | No `input_bytes`; `output_bytes` 4 MiB, `command_timeout_ms` 30000, `address_space_bytes` 1 GiB, `file_bytes` 64 MiB, `cpu_seconds` 30                                                        |
| `inspect_binary_layout`, `inspect_recorded_crash` (pwntools) | `input_bytes` 32 MiB (or `REA_PWNTOOLS_MAX_INPUT_BYTES`), `output_bytes` 64 MiB, `diagnostic_bytes` 1 MiB, `address_space_bytes` 3 GiB, `file_bytes` follows `output_bytes`, `cpu_seconds` 30 |
| `inspect_evm_interface`                                      | `input_bytes` 4 MiB, `output_bytes` 16 MiB, `diagnostic_bytes` 1 MiB, `address_space_bytes` 3 GiB, `file_bytes` follows `output_bytes` (16 MiB), `cpu_seconds` 30                             |
| `inspect_rust_binary`                                        | `input_bytes` 256 MiB, `output_bytes` 8 MiB. Dependency JSON uses `max_compressed_dependency_bytes` (1 MiB), `max_inflated_dependency_bytes` (8 MiB) and `max_dependency_inflate_ratio` (64)  |
| `inspect_sqlite_database`                                    | `input_bytes` 256 MiB (the database and WAL copied to the private snapshot)                                                                                                                   |
| `inspect_pcap_capture`                                       | `input_bytes` 2 GiB (the streamed capture snapshot), `output_bytes` 8 MiB of combined stdout and stderr per TShark JSON pass, at most 128 MiB (the fixed decoded-JSON allowance)              |
| `decode_android_resources`                                   | `output_bytes` 4 MiB of retained `apktool d` stdout and stderr, at most the JavaScript string limit                                                                                           |
| `inspect_asset_catalog`                                      | `output_bytes` 64 MiB for each assetutil stream and the JSON retained across all catalogs, at most 128 MiB (the in-process decode bound)                                                      |

#### Session default for producer output

`inspect_packet_capture`, `decode_signal_recording` and
`inspect_signal_decoders` share one session-adjustable default for
`producer_limits.output_bytes`: the registered setting `producer.output_bytes`
(launch seed `REA_PRODUCER_OUTPUT_BYTES`, default 4 MiB, range
1..9007199254740991 bytes). Change it with `update_analysis_settings`, for
example `{"changes":[{"setting":"producer.output_bytes","action":"set","value":16777216}]}`;
it applies to the next operation without restart. An explicit
`producer_limits.output_bytes` on a call wins over the setting, then the runtime
override, then the launch seed, then the default. An output refusal reports the
setting's limit with `parameter: "producer_limits.output_bytes"` and the
`source` of the value in force, so its recovery names both the per-call field
and the setting. `inspect_packet_fields` keeps its own 32 MiB glossary default
and is not covered by the setting. `decode_android_resources` and
`inspect_asset_catalog` use the same setting. While it is unset they keep
their own defaults (4 MiB and 64 MiB). An explicit runtime value or
`REA_PRODUCER_OUTPUT_BYTES` supplies the omitted field and is clamped to each
producer's maximum (the JavaScript string limit, and 128 MiB). A per-call
`producer_limits.output_bytes` still wins and is rejected above that maximum.

`inspect_rust_binary` bounds cargo-auditable dependency JSON with three
per-call parameters (CLI `--max-compressed-dependency-bytes`,
`--max-inflated-dependency-bytes`, `--max-dependency-inflate-ratio`). The
admitted inflated length is the smaller of `max_inflated_dependency_bytes` and
`max_dependency_inflate_ratio` times the consumed compressed length. Allocation
starts before that length is known, so it uses the stored extent, including PE
file-alignment padding. A refusal is an `adjustable_budget` whose
`details.limit` names the parameter that stopped the parse. `required_value` is
the measured section length, inflated length, or ratio when that measurement
finished; an allocation that stops first omits it. `producer_limits` does not
raise these parameters. Omitted fields keep the defaults above.

The pwntools and EVM operations take their wall-clock deadline from a separate
argument (`pwntools_timeout_ms`, `timeout_ms`) instead of `command_timeout_ms`.
Packet and signal results report the effective values as `limits`, where an
inherited OS ceiling can appear as `0`. When packet, signal, pwntools, Rust,
pcap, SQLite, Apktool or assetutil work exhausts a budget, `details.limit` carries `control_kind: "parameter"`,
`parameter: "producer_limits.<field>"`, `minimum: 1` and
`applies_at: "next_call"`, as described under [failure and retry](#failure-and-retry);
the other producers name the field to raise in their remediation. A pwntools
input refused by the runtime, launch or built-in `pwntools.max_input_bytes`
ceiling keeps that setting's limit instead. If the caller set the ceiling
through `producer_limits.input_bytes`, the parameter limit is used, and its
`default_value` is the ceiling that applies when the field is omitted. When
omitting it would fail configuration, no default exists and the setting limit
is reported. A pwntools memory allocation failure carries no
`details.limit`, whether it comes as a structured reply or as the bridge's
reserved exit: an allocation failure does not prove that
`producer_limits.address_space_bytes` was exhausted. Its message states the
selected allowance, and its remediation names the producer limits to review.

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
`pwntools_timeout_ms`) and applies on the next call. It carries its
`effective_value`, `unit`, `minimum`, `maximum` and `default_value`, and
`required_value` when the producer measured the smallest value that admits the
refused request. Services and their remediation text name only that field. A
CLI command adds `cli_flag`, the option that sets the field on that command,
from its own field-to-flag binding, and its recovery names that option and
command in place of the field and tool; MCP results do not carry it.
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

Read `update_mode` to see whether the setter can change the active value, and
`pending_restart` to see whether a configured value is waiting. A configuration
error for a Windows ChangeTime setting carries `update_mode` on
`details.settings`. Its rejected value does not establish an accepted pending
configuration, so `pending_restart` is omitted.

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

## Agent result budget

`delivery.agent_result_budget_bytes` is a delivery budget, not an admission
limit. It defaults to 32,768 compact JSON bytes. Claude Code moves MCP
results above 25,000 tokens out of context, and dense JSON (addresses,
digests, identifiers) measured about 2.9 bytes per token there, so the
default is about 11,000 tokens: under half the cap, with room for the
delivery facts. Token figures in delivery facts use an estimate of 3 bytes
per token, not a tokenizer measurement. The budget applies to tools with a
`detail` selector when the caller omits `detail`, on MCP and the CLI; it is
the only size that chooses between complete and summary delivery. An MCP
session summarizes only when it retains Evidence and advertises
`inspect_analysis_view`, which pages the summary; otherwise it delivers the
complete Evidence. Its launch seed, `REA_AGENT_RESULT_BUDGET_BYTES`, also
sets it for one-shot CLI invocations; an invalid seed leaves delivery
unbudgeted (complete, as before) rather than falling back to the default,
and settings inspection reports it. The stdio frame limit,
`REA_MCP_MAX_RESPONSE_BYTES`, stays a separate transport safety net.

When complete Evidence fits, it is delivered inline as before. When it does
not, the work is never refused or truncated:

- MCP retains the complete Evidence in the session and returns the
  operation's summary view, the same record `detail: "summary"` returns, so
  its identity holds wherever a summary is accepted. The delivery facts
  travel beside it, in a second text block `{"delivery": …}` and in
  `_meta["rea/agent-budget-delivery"]`: `budget_bytes`, `budget_source`, the
  range, `complete_bytes`, `estimated_complete_tokens`, `evidence_id`,
  `retained`, `next` (the exact `inspect_analysis_view` call that pages the
  complete record) and a `note` with the recovery.
- `inspect_analysis_view` with view
  `{kind: "evidence-json", offset, limit}` pages the exact JSON text of the
  retained record in UTF-16 code units. It is the recovery every client can
  follow. Joining every page in offset order
  reproduces it exactly, and no page splits a surrogate pair. With `limit`
  omitted a page holds at most 24,576 bytes of escaped UTF-8 text, so with
  its view Evidence it fits the default budget for any characters; an explicit `limit` counts code units,
  up to 1,048,576. The producer's own views (`managed-members`, `inventory`
  and so on) select facts more cheaply.
- For clients that read MCP resources, the summary also carries a
  `resource_link` to `rea://evidence/<evidence_id>`, named
  `complete-evidence`, whose `size` is the complete record's UTF-8 JSON
  bytes. `resources/read` returns the record's exact JSON in one read, the
  same text the cursor pages. The `rea://evidence/{evidence_id}` template
  appears in `resources/templates/list`, not `resources/list`, and reads any
  record the session retains. An ID the session does not retain (unknown,
  from another session, or cleared by `reset_investigation`) is refused with
  `-32602`. A record whose escaped read is too large for one response on
  the connection (`REA_MCP_MAX_RESPONSE_BYTES`, or REA's single-string
  limit) gets no link, and a read of it is refused with `-32600` and
  `data.next`, the cursor. The link and the read use the same check. Claude Code 2.1 shows the link
  to the model as one line, about 70 tokens, and never reads it by itself;
  when the model reads it, Claude Code saves a large read to a file and
  shows a preview.
- The CLI with `--evidence_output` prints
  `{"summary", "evidence_bundle", "delivery"}`, whose `delivery.next` names
  the bundle as an `evidence-file` source.
- Without `--evidence_output`, the one-shot CLI keeps the complete Evidence
  in its private retained-Evidence cache and prints the same three fields,
  with `retained: "cache-file"`. `evidence_bundle` gives the bundle file's path
  and size, and `record_sha256`, the digest of the complete record it holds
  (the file is the bundle around that record, so its own digest differs). `delivery.next` pages it with
  `rea inspect-analysis-view`, so the analysis never has to run again.
  Composed commands keep the source records the bundle needs, as they do
  for `--evidence_output`.
  - **Location:** `rea/evidence` under the user cache directory
    (`~/Library/Caches` on macOS, `XDG_CACHE_HOME` or `~/.cache` elsewhere).
    The directory is created `0700` and must be a real directory the user
    owns, never a symbolic link; files are created exclusively as `0600` by
    the Evidence bundle writer.
  - **Key and lifetime:** each file is named by the SHA-256 of the complete
    bundle's canonical JSON, including captured source records and caller
    paths that semantic Evidence IDs leave out. The separate
    `record_sha256` receipt still hashes only the complete parent record.
    A repeat with the same bundle reuses the file and never rewrites it. A repeat run, or a
    `rea inspect-analysis-view` read of the file, renews its age. Each
    retention removes records unused for 7 days, then the least recently
    used until the cache fits `delivery.cli_retained_evidence_bytes`
    (default 268,435,456 bytes, launch seed
    `REA_CLI_RETAINED_EVIDENCE_BYTES`), skipping any record used since it
    was listed. A record or bundle larger than the cache is not kept.
  - **Opt out:** `--no-retain` for one run, or
    `REA_CLI_RETAINED_EVIDENCE_BYTES=0` for every run that environment
    reaches. An invalid seed also retains nothing, and settings inspection
    reports it. The MCP server ignores this setting: its session retains
    over-budget Evidence instead.
  - **Fallback:** when nothing is kept (opted out, too large, a cache path
    that holds a value marked sensitive, or the save failed), the CLI writes
    nothing and prints `{"summary", "delivery"}`
    with `retained: "not-retained"`. `delivery.retention_failure` says why a
    save failed, and `delivery.rerun` gives the arguments to add to the
    original command as argv arrays: `complete` (`["--detail", "complete"]`)
    and `retained` (`["--evidence_output", "<new-bundle-path>"]`). The
    analysis never fails because of retention. A save that published the
    file but then failed (staging cleanup or cancellation) reports that
    failure and its cleanup state, as `--evidence_output` does; unfinished
    staging cleanup before commit likewise reports `cleanup_incomplete` with
    its remaining resources, and an oversized bundle whose post-write removal
    fails keeps its receipt, paging cursor, and `retention_failure`. Caller inputs are never
    echoed, since they can carry access credentials; the note names both.

A failure's own facts (code, `failure_kind`, retry, recovery and limits)
are never budgeted. Its `details.partial_observation`, the complete Evidence
of work that finished before the failure, gets the same decision with the
budget the rest of the failure leaves. When it fits, it is delivered as
before: inline, or on MCP as a `retained-evidence` reference when the
session retained it. When it does not fit, it is replaced by its summary
view, and `details.partial_observation_delivery` carries the same delivery
facts as a successful result. On MCP the session retains the complete
partial Evidence, `next` pages it, and a `resource_link` to it follows
the error text when one read can deliver it. On the CLI, `--evidence_output`
publishes it and `next` names the bundle. Without `--evidence_output`, it is
retained in the same private cache as a successful over-budget result
(`retained: "cache-file"`), with `details.diagnostics.evidence_bundle`
reporting its `path`, `bytes`, and `record_sha256` and `next` paging that
file. When retention is off (`--no-retain` or
`REA_CLI_RETAINED_EVIDENCE_BYTES=0`) or fails, nothing is written and `rerun`
names the arguments to add (with `retention_failure` when a write failed);
cancelled failures do not write to the cache.

Recovery: pass `detail: "complete"` (CLI `--detail complete`) for everything
inline on one call, or raise the setting for the runtime with
`update_analysis_settings`. An operation without a summary view, or with no
retained session, keeps complete delivery.

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

Every fixed ceiling a refusal declares (`fixedAllowanceOptions`,
`fixedProducerInputAllowance`, `artifactFixedLimitFailure` or an inline
`fixedAllowance`) is listed in
[`fixed-ceiling-registry.json`](https://github.com/morluto/rea/blob/main/scripts/verify/fixed-ceiling-registry.json)
under its file and allowance, with its class and reason: `format`,
`protocol`, `representation`, `derived` (grows with the admitted input or
another control), `forwarding` (relays a ceiling declared elsewhere), or
`pending` with the issue that tracks giving it a control.
`npm run lint` runs `scripts/verify/fixed-ceilings.mjs`, which fails on an
unregistered declaration and on a stale entry. A resource or admission limit
is not a fixed ceiling: give it a setting or per-call parameter and report
`details.limit`. The same script counts refusals whose only recovery is an
authored `remediationAction`, with no `limit`, `fixedAllowance` or
`measuredExhaustion`, against `scripts/verify/untyped-budget-refusal-baseline.json`;
that count may only shrink, and `--shrink-baselines` lowers it
([#14234](https://github.com/morluto/rea/issues/14234)).

A Nintendo 64 ROM above 64 MiB (67,108,864 bytes) is refused as the fixed
allowance "The Nintendo 64 ROM size allowance" (`n64.rom_bytes`). Retail
cartridge masks stop at 64 MiB (512 Mbit). The reader refuses the file before
swapping its bytes. This release has no runtime override.
`artifact_limits.expanded_bytes` does not raise it. A v64 or n64 dump also
counts a decoded copy of each member toward `artifact_limits.expanded_bytes`.

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

| Variant              | Producer fact                                                                                                                            | Projected fields                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixed_ceiling`      | `fixedAllowanceOptions(name, kind, { limit, unit, narrowing })`, or an artifact reader's `artifactFixedLimitFailure(allowance, outcome)` | `allowance`, `allowance_kind`, `limit`, `unit`, `narrowing`                                                                                         |
| `adjustable_budget`  | an `AnalysisSettingLimit`, or a `control_kind: "parameter"` limit, bound as `limit`                                                      | `control`, `setting` and `source` (settings only), `effective_value`, `unit`, `range`, `default_value` (parameters only), optional `required_value` |
| `ambiguous_selector` | `AnalysisInputError` option `ambiguousSelector: { field, candidates }`                                                                   | `field`, `candidates`                                                                                                                               |

Presentation is total over these variants. Authored remediation still wins,
so a producer that binds a parameter or setting limit omits it unless it adds
something the facts cannot say. Without it, the variant names the recovery:
fixed ceilings and their narrowing step, the budget's control and range for the
caller's lifetime, or the selector field and its candidates. A resource refusal
never falls back to text about worker limits, the MCP transport, or doctor. An
ambiguous selector conforms to the input contract, so it does not ask the
caller to inspect the schema.

### Adjustable budget recovery

The recovery is generated from the refusal's facts only, never from earlier
calls. `required_value` is the smallest value that admits the refused request;
the refusal reports it, in `details.limit` and `details.refusal`, whenever the
producer measured it. A producer that knows only a lower bound, such as the
reads counted before a refusal, omits it and reports the bound in
`details.reported_limits`.

- A per-call control reads "Pass a larger `<parameter>` on the next
  `<operation>` call (at least `<required_value>`; range
  `<minimum>..<maximum>`), then retry."
- A per-call control backed by a registered setting is reported as that
  setting's limit with `parameter` and `source` (see
  [precedence](#precedence-and-lifetime)). Its recovery names both routes:
  the per-call argument for one large input, then the setting for repeated
  work, "To raise it for this session, set `<setting>` with
  update_analysis_settings." A one-invocation caller (the CLI) gets the
  setting's launch environment variable instead, or only the per-call route
  when the setting has none.
- A per-call control without a backing setting has only the per-call route.
- When the control is already at its maximum, or `required_value` is above it,
  the recovery asks for a narrower request instead.
- On the CLI, the per-call step names the command's flag and command; MCP
  names the contract field and tool.

An environment control is not an adjustable budget. REA never raises a limit
on its own or retries a refused request automatically.

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
For a per-call control, pass at least `required_value` (when present) for
`parameter` on the next call; raise its backing setting instead when the same
limit keeps refusing work in this session. Follow `remediation.action` for
fixed and external controls.
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

`inspect_artifact` and `extract_artifact` accept `bun`, `dotnet_bundle`,
`node_sea`, `godot`, `iso9660`, `deno`, `wxapkg`, `tar` and
`android_sparse_image`, `android_vbmeta`, `media_asset` and `android_dtbo`
groups in `artifact_limits`. Their controls apply when
recognition or inventory encounters that format. Supplying a policy does not
assert the format is present. Unsupported keys are rejected. Each group follows
one domain-owned default policy. See [.NET bundles](../dotnet-bundles.md),
[Node SEA](../node-sea.md), [Godot PCK](../godot-pck.md),
[Bun standalone](../bun-standalone.md), [Deno compile](../deno-standalone.md),
[wxapkg](../wxapkg.md), [tar](../tar-archives.md),
[Android sparse images](../guides/firmware/android-sparse-image.md),
[Android vbmeta](../guides/firmware/android-vbmeta.md),
[media asset headers](../media-asset-headers.md) and
[Android DTBO partition images](../android-dtbo.md) for format semantics.

`artifact_limits.expanded_bytes` selects aggregate plaintext work for ZIP, Bun,
SEA, PCK, ISO 9660, Deno, wxapkg, tar, macOS flat `.pkg` (including
`Scripts`/`Payload` cpio archive decoding and scaled cpio member and path-byte
allowances, plus `Distribution`/`PackageInfo` metadata decoding and scaled
metadata record and XML-node allowances), Android sparse image and Android DTBO
readers (every DTBO row is charged, including rows that share one payload), NSO
segment decompression, and bFLT gzip decompression (which is also capped at a
fixed 128 MiB in-memory inflation ceiling), including repeated readable logical
occurrences. Omission retains each archive's encoded-size-derived default. The
.NET bundle group's own `expanded_bytes` controls its independently enforced
bundle expansion.

Mega Drive and Genesis ROM inventory admits a linear image of at most 8 MiB
(`The Mega Drive ROM byte ceiling`, 8388608 bytes) and an SMD copier dump of
at most 512 blocks of 16 KiB plus the 512-byte copier header (`The Mega Drive
SMD block ceiling`). Both are fixed format ceilings. This release has no
runtime override. See
[Sega Mega Drive ROMs](../guides/firmware/mega-drive-roms.md).

`artifact.member_count` (launch seed `REA_ARTIFACT_MEMBER_COUNT`, default
100,000, range 1 to 2,147,483,647) is the session default for the per-call
member counts `bun.module_count`, `dotnet_bundle.entry_count`,
`node_sea.asset_count` and `deno.vfs_entries`. An explicit `artifact_limits`
field wins for that call; otherwise the runtime override, then the launch
seed, then the default applies (see [precedence](#precedence-and-lifetime)).
A refusal at one of those fields also reports `details.limit` as that
setting's limit, with the field as `parameter` and the value's `source`, so the
recovery names both routes: the field for one large artifact, then
`update_analysis_settings` (or the launch seed for a CLI invocation) for
repeated work. When a non-default session value applies, inventory and
extraction report the resolved `effective_limits` even if the call selected no
`artifact_limits`. Other reader fields are per-call only.

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
