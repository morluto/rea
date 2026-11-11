/**
 * Numeric `REA_` limits that are not runtime analysis settings.
 *
 * The static check in `scripts/verify/rea-numeric-limits.mjs` fails when a
 * numeric `REA_` limit in `src` is absent from both this list and
 * `ANALYSIS_SETTINGS`. `restart-only` is the durable exception. `per-call`
 * names a limit still read from the launch environment on each use; the
 * runtime migration deletes that entry instead of leaving it here.
 *
 * Narrative bounds, owners, and the non-numeric settings live in
 * `docs/design/rea-limit-inventory.md`.
 */
export interface NumericLimitRegistryEntry {
  readonly name: string;
  readonly update_mode: "restart";
  readonly policy: "restart-only" | "per-call";
  readonly read: "startup" | "per-call";
  readonly reason: string;
}

export const NUMERIC_LIMIT_REGISTRY = [
  {
    name: "REA_BRIDGE_MAX_REQUEST_BYTES",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "The Hopper, Ghidra, and Cutter clients measure each request against this ceiling. The value is still taken from the launch environment, so a running process does not see a new value until the runtime migration removes this entry.",
  },
  {
    name: "REA_DEBUGGER_COMMAND_DEADLINE_MS",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "GDB and Rizin apply this deadline to each debugger command. The session manager currently copies it at construction from the launch environment; the runtime migration reads the accepted operation snapshot instead.",
  },
  {
    name: "REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "Each debugger command retains output up to this ceiling. The session manager currently copies it at construction from the launch environment; the runtime migration reads the accepted operation snapshot instead.",
  },
  {
    name: "REA_DEBUGGER_MAX_PENDING_COMMANDS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Caps the pending-command queue created with the debugger session manager. It is pool capacity for that manager, not a budget checked independently on each command.",
  },
  {
    name: "REA_DEBUGGER_MAX_SESSIONS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Caps how many debugger sessions the session manager created at startup will admit. Changing the pool size of a manager that already exists requires a new REA process.",
  },
  {
    name: "REA_HOPPER_CALLER_SCAN_BUDGET_MS",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "Forward caller reconciliation reads this budget for each scan. It is still resolved from the launch environment; the runtime migration reads the accepted operation snapshot.",
  },
  {
    name: "REA_HOPPER_DEMO_DIALOG_TIMEOUT_MS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "The Linux private-display adapter reads this watch from the process environment when that helper starts. A running adapter does not observe a value stored only in the REA process.",
  },
  {
    name: "REA_JADX_ACTIVE_PROCESSOR_COUNT",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Passed to the JVM as -XX:ActiveProcessorCount when the JADX worker process starts. A running JVM does not adopt a new processor count.",
  },
  {
    name: "REA_JADX_HEAP_MIB",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Passed to the JVM as -Xmx when the JADX worker process starts. A running JVM does not adopt a new heap size.",
  },
  {
    name: "REA_JEB_MCP_TIMEOUT_MS",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "Bounds each JEB tools/call and catalog discovery. The connection currently captures the launch value when it is created; the runtime migration reads the accepted snapshot for each request.",
  },
  {
    name: "REA_KUNA_CACHE_MAX_BYTES",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Sizes the Kuna project cache when that cache is constructed for the provider. An existing cache does not resize from a later value.",
  },
  {
    name: "REA_KUNA_JOBS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Selects the Kuna worker-pool width when the provider builds its run slots. The pool is not resized for a process that is already running.",
  },
  {
    name: "REA_KUNA_PROJECT_TIMEOUT_MS",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "Bounds a Kuna project export and the whole-program scans that use that deadline. The configuration object still comes from the launch environment; the runtime migration reads the accepted snapshot at each use.",
  },
  {
    name: "REA_KUNA_TIMEOUT_MS",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "Bounds one Kuna function decompile. The configuration object still comes from the launch environment; the runtime migration reads the accepted snapshot at each use.",
  },
  {
    name: "REA_MCP_DOCTOR_DEADLINE_MS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Bounds the MCP doctor phase while the server is starting. It shapes server startup, not a later analysis call.",
  },
  {
    name: "REA_MCP_FIRST_CATALOG_BUDGET_MS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Bounds the first MCP catalog phase while the server is starting. It shapes server startup, not a later analysis call.",
  },
  {
    name: "REA_MCP_INITIALIZE_BUDGET_MS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Bounds the MCP initialize phase while the server is starting. It shapes server startup, not a later analysis call.",
  },
  {
    name: "REA_MCP_MAX_INPUT_ELEMENTS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Sizes argument admission for the MCP server created at process start. A running server does not rebuild that parser for a new allowance.",
  },
  {
    name: "REA_MCP_MAX_RESPONSE_BYTES",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Sizes the MCP stdio receive buffer when the server process starts. A running transport and the paired client buffer do not adopt a new ceiling.",
  },
  {
    name: "REA_MCP_TOOLS_LIST_BUDGET_MS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Bounds the MCP tools/list phase while the server is starting. It shapes server startup, not a later analysis call.",
  },
  {
    name: "REA_PWNTOOLS_MAX_INPUT_BYTES",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "Default artifact-size admission for a pwntools decode. A per-call producer_limits.input_bytes override already exists; the launch default is still read from the environment and the runtime migration moves that default into the snapshot.",
  },
  {
    name: "REA_RECONNECT_TIMEOUT_SECONDS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Fixed 30-second value written into the Hopper bridge helper from HOPPER_SHUTDOWN_TIMEOUT_MS. It is not a caller-selected launch setting.",
  },
  {
    name: "REA_SWIFTC_COMPILE_TIMEOUT_MS",
    update_mode: "restart",
    policy: "restart-only",
    read: "startup",
    reason:
      "Captured when the Darwin ownership-helper reader is constructed at process start. That helper compile uses the captured deadline, so a later value needs a new REA process.",
  },
  {
    name: "REA_WINDOWS_CHANGE_TIME_DRIFT_MS",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "Each Windows ChangeTime observation compares the file against this drift window. The observation still parses the launch environment; the runtime migration reads the accepted operation snapshot.",
  },
  {
    name: "REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "Each Windows ChangeTime settle loop stops after this many polls. The observation still parses the launch environment; the runtime migration reads the accepted operation snapshot.",
  },
  {
    name: "REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS",
    update_mode: "restart",
    policy: "per-call",
    read: "per-call",
    reason:
      "Each Windows ChangeTime settle loop waits this long between reads. The observation still parses the launch environment; the runtime migration reads the accepted operation snapshot.",
  },
] as const satisfies readonly NumericLimitRegistryEntry[];
