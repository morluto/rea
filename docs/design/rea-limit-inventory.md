# REA limit inventory

Audit for [#9881](https://github.com/morluto/rea/issues/9881). Counts below are
from this revision of `src`. A numeric `REA_` limit is a name under `src` (tests
excluded) that carries a byte, time, count, heap, budget, deadline, or maximum.
`scripts/verify/rea-numeric-limits.mjs` fails the static checks when one of those
names is neither an environment seed of
[`ANALYSIS_SETTINGS`](https://github.com/morluto/rea/blob/main/src/domain/analysisSettingDefinitions.ts) nor an
entry in [`numericLimitRegistry.ts`](https://github.com/morluto/rea/blob/main/src/domain/numericLimitRegistry.ts)
with a reason.

`update_mode` is `runtime` when `update_analysis_settings` can change the active
value, `restart` when this process keeps the value it started with, and
`parameter` when this call supplied the value.
`pending_restart` is true only when a configured value is not the one this
process is using. A rejected Windows ChangeTime launch value is not active, so
that failure reports `pending_restart: true`. Every other value reported here
is the one in force, so `pending_restart` is false. Prose that only says to
restart REA is marked `prose`. `mcp_server_restart_required` is a
server-identity alignment state in `src/serverIdentity.ts`, not a setting field.

Three numeric limits are absent from this tree and are being moved into the
runtime system on their own PRs. This audit does not change them:

| Name                                         | Tracking |
| -------------------------------------------- | -------- |
| `REA_NTFS_MFT_MAX_FILE_BYTES`                | #9868    |
| `REA_REGF_HIVE_MAX_FILE_BYTES`               | #9865    |
| `REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES` | #9836    |

When those names land in `src`, the static check requires them to be analysis
settings. They are not on the restart-only list.

## Counts

| Category                                                              |                                                                        Count |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------: |
| Runtime analysis settings                                             |                  17 (14 have an `REA_` seed; 3 are per-call parameters only) |
| Per-call numeric `REA_` limits still read from the launch environment |                                                                           11 |
| Restart-only numeric `REA_` limits                                    |                                                                           15 |
| Numeric `REA_` names discovered in `src`                              |                                                                           40 |
| Non-numeric `REA_` settings kept restart-only                         | 53 caller settings, plus process-protocol names that are not caller settings |
| Hardcoded ceilings left for follow-up                                 |                        grouped below; none converted in the inventory change |

## Runtime analysis settings

Already adjustable with `update_analysis_settings`. Each call reads the snapshot
accepted for that operation. Launch source is `default` or `setting`; a runtime
override is `source: "runtime"`. The structured field is `update_mode: "runtime"` and `pending_restart: false`.
`applies_at` is the finer point
(`next_operation`, `next_worker`, or `next_startup`).

| Setting                                      | Environment seed                                 | Owner                                                         | Default                                   |            Floor |                                Maximum | Read                  |
| -------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------- | ---------------: | -------------------------------------: | --------------------- |
| `asar.max_header_bytes`                      | `REA_ASAR_MAX_HEADER_BYTES`                      | `src/domain/analysisResourceLimits.ts`                        | 16777216                                  |                1 |                              268435456 | per operation         |
| `asar.max_listing_bytes`                     | `REA_ASAR_MAX_LISTING_BYTES`                     | `src/domain/analysisResourceLimits.ts`                        | 67108864                                  |                1 |              `Number.MAX_SAFE_INTEGER` | per operation         |
| `ghidra.value_flow_max_operations`           | `REA_GHIDRA_VALUE_FLOW_MAX_OPERATIONS`           | `src/domain/analysisResourceLimits.ts`                        | 3000                                      |                1 |                             2147483647 | per operation         |
| `ghidra.value_flow_max_inputs_per_operation` | `REA_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION` | `src/domain/analysisResourceLimits.ts`                        | 64                                        |                1 |                             2147483647 | per operation         |
| `ghidra.value_flow_max_edges`                | `REA_GHIDRA_VALUE_FLOW_MAX_EDGES`                | `src/domain/analysisResourceLimits.ts`                        | 12000                                     |                1 |                             2147483647 | per operation         |
| `ghidra.decompile_max_payload_mib`           | `REA_GHIDRA_DECOMPILE_MAX_PAYLOAD_MIB`           | `src/domain/analysisResourceLimits.ts`                        | unset (`null`, unbounded payload policy)  |                1 |                                   2047 | per operation         |
| `ghidra.startup_timeout_ms`                  | `REA_GHIDRA_STARTUP_TIMEOUT_MS`                  | `src/domain/analysisResourceLimits.ts`                        | 330000                                    |                1 |                             2147483647 | next provider startup |
| `hopper.startup_timeout_ms`                  | `REA_HOPPER_STARTUP_TIMEOUT_MS`                  | `src/domain/analysisResourceLimits.ts`                        | 120000                                    |                1 |                             2147483647 | next provider startup |
| `ghidra.decompile_timeout_seconds`           | `REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS`           | `src/domain/analysisResourceLimits.ts`                        | unset (`null`, decompile stays unbounded) |                1 | `MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS` | per operation         |
| `jadx.operation_timeout_ms`                  | `REA_JADX_OPERATION_TIMEOUT_MS`                  | `src/domain/analysisResourceLimits.ts`                        | 120000                                    |                1 |                             2147483647 | per operation         |
| `regex.matching_deadline_ms`                 | `REA_REGEX_MATCHING_DEADLINE_MS`                 | `src/domain/analysisResourceLimits.ts`                        | 5000                                      |                1 |                             2147483647 | per operation         |
| `regex.worker_heap_request_mib`              | `REA_REGEX_WORKER_HEAP_REQUEST_MIB`              | `src/domain/analysisResourceLimits.ts`                        | 128                                       |                7 |                                  16384 | next worker           |
| `capture.decoder_old_generation_mib`         | `REA_CAPTURE_DECODER_OLD_GENERATION_MIB`         | `src/domain/analysisResourceLimits.ts`                        | 192                                       | semi-space floor |                                  16384 | next worker           |
| `javascript.analysis_timeout_ms`             | none (`analysis_timeout_ms`)                     | `src/domain/javascript/javascriptAnalysisResourceControls.ts` | owner default                             |                1 |                             2147483647 | per operation         |
| `javascript.max_heap_mb`                     | none (`max_heap_mb`)                             | `src/domain/javascript/javascriptAnalysisResourceControls.ts` | owner default                             |      owner floor |                          owner maximum | next worker           |
| `wasm.command_timeout_ms`                    | none (`command_timeout_ms`)                      | `src/domain/wasm/wasmArtifact.ts`                             | owner default                             |                1 |                          owner maximum | per operation         |
| `native.matching_representation_bytes`       | `REA_NATIVE_MATCHING_REPRESENTATION_BYTES`       | `src/domain/analysisResourceLimits.ts`                        | 100663296                                 |                1 |                             1073741824 | per operation         |

An out-of-range `update_analysis_settings` value is rejected by the setting's
schema. Invalid launch seeds that the global environment parser accepts as
provider-local stay inspectable with `source: "invalid"`.

## Per-call limits still outside the runtime system

These are checked when the work runs. They keep the `REA_` variable, default,
floor, and maximum, and the migration reads the accepted snapshot instead of a
value copied at process start. Until that lands they are `policy: "per-call"` in
the registry so the static check still requires a reason.

| Environment                                | Owner                                       |                 Default | Floor |    Maximum | Read today                                                                            | Restart field                                                                   |
| ------------------------------------------ | ------------------------------------------- | ----------------------: | ----: | ---------: | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `REA_BRIDGE_MAX_REQUEST_BYTES`             | `src/config/bridgeMaxRequestBytes.ts`       |                16777216 |  7464 |  536870887 | each bridge request, from the launch value                                            | prose                                                                           |
| `REA_DEBUGGER_COMMAND_DEADLINE_MS`         | `src/domain/analysisResourceLimits.ts`      |                  120000 |     1 | 2147483647 | copied when the debugger manager is constructed; applied to each command              | `update_mode: "restart"` and `pending_restart: false`                           |
| `REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES`    | `src/domain/analysisResourceLimits.ts`      |                16777216 |     1 |   89303718 | copied when the debugger manager is constructed; applied to each command              | `update_mode: "restart"` and `pending_restart: false`                           |
| `REA_HOPPER_CALLER_SCAN_BUDGET_MS`         | `src/domain/analysisResourceLimits.ts`      |                    2000 |     1 | 2147483647 | each caller-scan operation, from config resolved at launch                            | prose                                                                           |
| `REA_JEB_MCP_TIMEOUT_MS`                   | `src/jeb/JebMcpConnection.ts`               | 60000 (MCP SDK default) |     1 | 2147483647 | captured when the JEB connection is created; applied to discovery and each tools/call | prose                                                                           |
| `REA_KUNA_PROJECT_TIMEOUT_MS`              | `src/kuna/KunaConfiguration.ts`             |                 1800000 |     1 | 2147483647 | project export and whole-program scans, from the launch configuration                 | prose                                                                           |
| `REA_KUNA_TIMEOUT_MS`                      | `src/kuna/KunaConfiguration.ts`             |                  120000 |     1 | 2147483647 | each function decompile, from the launch configuration                                | prose                                                                           |
| `REA_PWNTOOLS_MAX_INPUT_BYTES`             | `src/native/pwntools/PwntoolsInputLimit.ts` |                33554432 |     1 | 1073741824 | each pwntools decode, unless the call passes `producer_limits.input_bytes`            | prose                                                                           |
| `REA_WINDOWS_CHANGE_TIME_DRIFT_MS`         | `src/config/windowsChangeTimeSettle.ts`     |                    2000 |     1 |      60000 | each ChangeTime observation                                                           | `update_mode: "restart"` and `pending_restart: true` on an invalid launch value |
| `REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS`   | `src/config/windowsChangeTimeSettle.ts`     |                      25 |     1 |       1000 | each ChangeTime observation                                                           | `update_mode: "restart"` and `pending_restart: true` on an invalid launch value |
| `REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS` | `src/config/windowsChangeTimeSettle.ts`     |                      40 |     1 |       1000 | each ChangeTime observation                                                           | `update_mode: "restart"` and `pending_restart: true` on an invalid launch value |

## Restart-only numeric limits

These stay out of `update_analysis_settings`.

| Environment                         | Owner                                  |             Default |    Floor |                   Maximum | Read                                        | Why restart-only                                                                                            |
| ----------------------------------- | -------------------------------------- | ------------------: | -------: | ------------------------: | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `REA_DEBUGGER_MAX_PENDING_COMMANDS` | `src/domain/analysisResourceLimits.ts` |                  16 |        1 |                       256 | debugger manager construction               | Queue capacity of the manager created at startup. `update_mode: "restart"` and `pending_restart: false`.    |
| `REA_DEBUGGER_MAX_SESSIONS`         | `src/domain/analysisResourceLimits.ts` |                   8 |        1 |                        64 | debugger manager construction               | Session-pool size of the manager created at startup. `update_mode: "restart"` and `pending_restart: false`. |
| `REA_HOPPER_DEMO_DIALOG_TIMEOUT_MS` | `src/domain/hopperStartupFailure.ts`   |               10000 |        1 |                2147483647 | Linux private-display adapter start         | The helper reads the process environment. Prose restart.                                                    |
| `REA_JADX_ACTIVE_PROCESSOR_COUNT`   | `src/android/JadxConfiguration.ts`     | unset (JVM default) |        1 |                2147483647 | JADX JVM launch                             | `-XX:ActiveProcessorCount` is fixed for that JVM. Prose on invalid values.                                  |
| `REA_JADX_HEAP_MIB`                 | `src/android/JadxConfiguration.ts`     | unset (JVM default) |        1 | `Number.MAX_SAFE_INTEGER` | JADX JVM launch                             | `-Xmx` is fixed for that JVM. Prose on invalid values.                                                      |
| `REA_KUNA_CACHE_MAX_BYTES`          | `src/kuna/KunaConfiguration.ts`        |          4294967296 |  1048576 | `Number.MAX_SAFE_INTEGER` | Kuna cache construction                     | The cache is sized once for the provider. Prose restart.                                                    |
| `REA_KUNA_JOBS`                     | `src/kuna/KunaConfiguration.ts`        |                   1 |        1 |                        32 | Kuna run-slot construction                  | Worker-pool width for the provider. Prose restart.                                                          |
| `REA_MCP_DOCTOR_DEADLINE_MS`        | `src/config/mcpStartupBudgets.ts`      |               30000 |        1 |                2147483647 | MCP server startup                          | Startup phase of the MCP server itself. Prose.                                                              |
| `REA_MCP_FIRST_CATALOG_BUDGET_MS`   | `src/config/mcpStartupBudgets.ts`      |               20000 |        1 |                2147483647 | MCP server startup                          | Startup phase of the MCP server itself. Prose.                                                              |
| `REA_MCP_INITIALIZE_BUDGET_MS`      | `src/config/mcpStartupBudgets.ts`      |               15000 |        1 |                2147483647 | MCP server startup                          | Startup phase of the MCP server itself. Prose.                                                              |
| `REA_MCP_MAX_INPUT_ELEMENTS`        | `src/config/mcpInputBudget.ts`         |                1024 |        1 | `Number.MAX_SAFE_INTEGER` | MCP server creation                         | Argument admission for the server process. Prose restart.                                                   |
| `REA_MCP_MAX_RESPONSE_BYTES`        | `src/config/mcpResponseBudget.ts`      | 10485760 when unset | 10485760 | `Number.MAX_SAFE_INTEGER` | MCP server creation                         | Stdio receive buffer and the paired client buffer. Prose restart.                                           |
| `REA_MCP_TOOLS_LIST_BUDGET_MS`      | `src/config/mcpStartupBudgets.ts`      |                5000 |        1 |                2147483647 | MCP server startup                          | Startup phase of the MCP server itself. Prose.                                                              |
| `REA_RECONNECT_TIMEOUT_SECONDS`     | `src/hopper/BridgeLauncher.ts`         |                  30 |       30 |                        30 | written into the Hopper bridge helper       | Not a caller setting. It is `HOPPER_SHUTDOWN_TIMEOUT_MS / 1000`.                                            |
| `REA_SWIFTC_COMPILE_TIMEOUT_MS`     | `src/config/providerStartupTimeout.ts` |              120000 |        1 |                2147483647 | Darwin ownership-helper reader construction | Captured at process start for that helper compile. Prose restart.                                           |

## Restart-only non-numeric settings

No floor or maximum. They are read from the launch environment (startup). None of them set `effect`. Recovery text tells the caller to change the launch
environment, which takes effect on the next process. They stay
restart-only because they choose a command, a binary, a filesystem root, the
browser sandbox, secret patterns, the provider, or the shape of the MCP server
or logger.

| Name                                 | Owner                                              | Why                                         |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------- |
| `REA_ADB_PATH`                       | `src/adb/AdbConfiguration.ts`                      | Caller-selected executable path.            |
| `REA_AGENT_ENV_COMMAND`              | `src/application/DesktopBuildDoctor.ts`            | Caller-selected command.                    |
| `REA_ANALYSIS_PROVIDER`              | `src/config/environment.ts`                        | Provider choice for the process.            |
| `REA_APKTOOL_COMMAND`                | `src/apktool/ApktoolConfiguration.ts`              | Caller-selected command.                    |
| `REA_BINWALK_COMMAND`                | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected command.                    |
| `REA_BROWSER_EXECUTABLE`             | `src/application/CapabilityInventory.ts`           | Caller-selected browser binary.             |
| `REA_BROWSER_NO_SANDBOX`             | `src/application/SetupRegistrationEnvironment.ts`  | Browser sandbox policy.                     |
| `REA_CAPINFOS_COMMAND`               | `src/pcap/PcapConfiguration.ts`                    | Caller-selected command.                    |
| `REA_CUTTER_BRIDGE_DIR`              | `src/application/SetupRegistrationEnvironment.ts`  | Filesystem root for the Cutter bridge.      |
| `REA_DARWIN_MODULE_CACHE_PATH`       | `src/application/SetupRegistrationEnvironment.ts`  | Filesystem path for the Swift module cache. |
| `REA_DARWIN_SWIFTC_PATH`             | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected compiler path.              |
| `REA_DCONF_COMMAND`                  | `src/desktop/DconfDatabaseReader.ts`               | Caller-selected command.                    |
| `REA_DOCKER_COMMAND`                 | `src/application/DesktopBuildDoctor.ts`            | Caller-selected command.                    |
| `REA_ELECTRON_CAPTURE_ARGV`          | `src/browser/PlaywrightElectronActiveProvider.ts`  | Caller-selected process arguments.          |
| `REA_EVM_PRLIMIT_COMMAND`            | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected command.                    |
| `REA_FIRMWARE_PRLIMIT_COMMAND`       | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected command.                    |
| `REA_GDB_COMMAND`                    | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected debugger binary.            |
| `REA_GHIDRA_CHECKPOINT_DIR`          | `src/config/environment.ts`                        | Filesystem root.                            |
| `REA_GHIDRA_COMPILER_SPEC_ID`        | `src/config/environment.ts`                        | Provider analysis choice.                   |
| `REA_GHIDRA_DISABLED_ANALYZERS`      | `src/config/environment.ts`                        | Provider analysis choice.                   |
| `REA_GHIDRA_LANGUAGE_ID`             | `src/config/environment.ts`                        | Provider analysis choice.                   |
| `REA_GHIDRA_NATIVEAOT_JAR`           | `src/config/environment.ts`                        | Caller-selected binary path.                |
| `REA_GHIDRA_PROGRAM_NAME`            | `src/config/environment.ts`                        | Provider project selection.                 |
| `REA_GHIDRA_PROJECT_PATH`            | `src/config/environment.ts`                        | Filesystem root.                            |
| `REA_GHIDRA_SEED_FILE`               | `src/config/environment.ts`                        | Filesystem path.                            |
| `REA_IDA_MCP_CONFIG`                 | `src/config/environment.ts`                        | Filesystem path of the IDA MCP config.      |
| `REA_ILSPY_CMD_PATH`                 | `src/config/environment.ts`                        | Caller-selected executable path.            |
| `REA_JADX_MCP_JAR`                   | `src/android/JadxConfiguration.ts`                 | Caller-selected binary path.                |
| `REA_JAVASCRIPT_PRLIMIT_COMMAND`     | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected command.                    |
| `REA_JEB_MCP_URL`                    | `src/config/environment.ts`                        | Provider endpoint.                          |
| `REA_KUNA_CACHE_DIR`                 | `src/kuna/KunaConfiguration.ts`                    | Filesystem root.                            |
| `REA_KUNA_COMMAND`                   | `src/kuna/KunaConfiguration.ts`                    | Caller-selected executable path.            |
| `REA_LOG_LEVEL`                      | `src/config/environment.ts`                        | Logger configuration for the process.       |
| `REA_MANAGED_LINUX_HOPPER_LAUNCHER`  | `src/application/HopperLauncherDiscovery.ts`       | Caller-selected launcher path.              |
| `REA_MCP_INPUT_SCHEMA_PROFILE`       | `src/config/environment.ts`                        | MCP server schema shape.                    |
| `REA_MCP_OUTPUT_SCHEMA_PROFILE`      | `src/config/environment.ts`                        | MCP server schema shape.                    |
| `REA_MCP_TOOL_CATALOG_PROFILE`       | `src/config/environment.ts`                        | MCP server catalog shape.                   |
| `REA_MCP_TOOL_FAMILIES`              | `src/config/environment.ts`                        | Which tools the MCP server registers.       |
| `REA_MITMDUMP_COMMAND`               | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected command.                    |
| `REA_OBJDUMP_COMMAND`                | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected command.                    |
| `REA_PWNDBG_GDB`                     | `src/native/pwndbg/PwndbgCoreContext.ts`           | Caller-selected debugger binary.            |
| `REA_PWNDBG_GDBINIT`                 | `src/native/pwndbg/PwndbgCoreContext.ts`           | Caller-selected file path.                  |
| `REA_PWNDBG_VENV_PATH`               | `src/native/pwndbg/PwndbgCoreContext.ts`           | Filesystem root.                            |
| `REA_PWNTOOLS_PYTHON`                | `src/native/pwntools/PwntoolsDecoder.ts`           | Caller-selected interpreter path.           |
| `REA_REFERENCE_SECRET_PATTERNS_JSON` | `src/config/environment.ts`                        | Secret-pattern policy.                      |
| `REA_RIZIN_COMMAND`                  | `src/rizin/RizinDebugSessionManager.ts`            | Caller-selected debugger binary.            |
| `REA_SIGROK_COMMAND`                 | `src/signals/SigrokRecordingProvider.ts`           | Caller-selected command.                    |
| `REA_SIGROK_PRLIMIT_COMMAND`         | `src/signals/SigrokRecordingProvider.ts`           | Caller-selected command.                    |
| `REA_TSHARK_COMMAND`                 | `src/pcap/PcapConfiguration.ts`                    | Caller-selected command.                    |
| `REA_TSHARK_PRLIMIT_COMMAND`         | `src/pcap/PcapNativeBound.ts`                      | Caller-selected command.                    |
| `REA_UNBLOB_COMMAND`                 | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected command.                    |
| `REA_WABT_BIN_DIRECTORY`             | `src/wasm/WabtArtifactProvider.ts`                 | Filesystem root of the WABT tools.          |
| `REA_WAKARU_COMMAND`                 | `src/application/SetupRegistrationEnvironment.ts`  | Caller-selected command.                    |
| `REA_WORKFLOW_PROVIDER`              | `src/application/DirectAnalysis.ts`                | Provider choice.                            |
| `REA_XPROP_COMMAND`                  | `src/application/desktop/DesktopCaptureFailure.ts` | Caller-selected command.                    |

Names that look like `REA_` but are process protocol, not caller settings:
`REA_BUILD_COMMIT`, `REA_BUILD_COMPUTER_REA_ARCHIVE`, `REA_INSTALL_SCRIPT`,
`REA_OWNS_PROCESS_LIFETIME`, `REA_PAYLOAD`, `REA_PROCESS_RUN_ID`, `REA_RUN_ID`,
`REA_SOCKET`, `REA_STATE_FORMAT`, `REA_TARGET_PATH`, `REA_TOKEN`, bridge markers
such as `REA_COMMAND_COMPLETE_`, and the `ERR_REA_WINDOWS_NATIVE` code.
`GHIDRA_INSTALL_DIR`, `JAVA_HOME`, `HOPPER_LAUNCHER_PATH`, `HOPPER_TARGET_PATH`,
`HOPPER_TARGET_KIND`, and `HOPPER_LOADER_ARGS_JSON` are launch configuration
without the `REA_` prefix. Paths and the provider choice among them stay
restart-only for the same reason as the table above.

## Hardcoded ceilings left for follow-up

These are checked per call and tell the caller this release has no runtime
override. They are not `REA_` settings, so the numeric-limit check does not
list them. Each family has its own owner. Turning one into a setting needs that
owner's default, floor, maximum, and an error that carries the setting id,
value, source, and range. Format and protocol ceilings that the
[limits guide](limits-and-recovery.md) already calls fixed stay fixed. In
particular, JSON nesting stops at `MAX_JSON_DEPTH` (1000) and the debugger
control-reply budget stays separate from
`REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES`.

| Family                                           | Examples                                                                                                     | Follow-up                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Native structural input ceilings                 | PE resources, imports, load config, certificates, exports, initializers, binary hardening, Windows shortcuts | One setting per ceiling, or a shared input budget only where the owners match.              |
| Native plist                                     | `MAX_NATIVE_PLIST_BYTES`, decode bytes, nesting depth                                                        | Separate from JSON depth.                                                                   |
| SQLite inspection                                | concurrent inspections, input bytes, diagnostic bytes                                                        | Pool width stays restart-only if it sizes the worker set; byte budgets can become settings. |
| Producer command allowances                      | fixed command deadline and retained output where the text says there is no runtime override                  | Distinct from per-call `producer_limits`.                                                   |
| Hopper caller-scan retention and page allowances | `HOPPER_CALLER_SCAN_RETENTION_BYTES`, `HOPPER_CALLER_PAGE_ALLOWANCE_BYTES`                                   | Explicitly not raised by the scan time budget.                                              |
| Rizin frame protocol                             | `MAX_FRAME_BYTES`, queued frames                                                                             | Protocol bounds, not caller budgets.                                                        |
| Debugger detach and control replies              | `DETACH_TIMEOUT_MS`, `DEBUGGER_CONTROL_REPLY_BYTES`                                                          | Ownership deadlines, not the shared command deadline.                                       |
| Web network capture nesting                      | `max_nesting_depth` already has a per-call parameter                                                         | The fixed depth maximum is the follow-up, not the parameter.                                |

## Static check

`npm run lint` runs `scripts/verify/rea-numeric-limits.mjs` after
dependencies are installed. `scripts/verify/architecture-guards.mjs` runs the
same check when `typescript6` is already installed; the pre-install CI step
cannot. The check scans `src` excluding tests,
keeps names that are numeric limits, and requires each name to be an
`environment` on an analysis setting or a registry entry with a reason.
`policy: "per-call"` is temporary. The migration that moves the limit deletes
the entry and rejects any new `per-call` policy so the durable exceptions are
only `restart-only`.
