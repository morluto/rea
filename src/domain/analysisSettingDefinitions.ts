import { z } from "zod";
import type {
  AnalysisInvocationSettingLimit,
  AnalysisSettingId,
  AnalysisSettingLimit,
} from "./analysisSettings.js";
import {
  DEFAULT_ASAR_MAX_HEADER_BYTES,
  MAXIMUM_ASAR_MAX_HEADER_BYTES,
  DEFAULT_ASAR_MAX_LISTING_BYTES,
  MAXIMUM_ASAR_MAX_LISTING_BYTES,
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_OPERATIONS,
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION,
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_EDGES,
  MAXIMUM_GHIDRA_VALUE_FLOW_RECORDS,
  MAXIMUM_GHIDRA_DECOMPILE_PAYLOAD_MIB,
  DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS,
  DEFAULT_HOPPER_STARTUP_TIMEOUT_MS,
  MAX_NODE_TIMER_DELAY_MS,
  MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS,
  DEFAULT_REGEX_MATCHING_DEADLINE_MS,
  MAXIMUM_REGEX_MATCHING_DEADLINE_MS,
  DEFAULT_REGEX_WORKER_HEAP_REQUEST_MIB,
  MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
  MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
  DEFAULT_CAPTURE_DECODER_OLD_GENERATION_MIB,
  CAPTURE_DECODER_SEMI_SPACE_MIB,
  MAXIMUM_CAPTURE_DECODER_OLD_GENERATION_MIB,
  DEFAULT_JADX_OPERATION_TIMEOUT_MS,
  DEFAULT_NATIVE_MATCHING_REPRESENTATION_BYTES,
  MAXIMUM_NATIVE_MATCHING_REPRESENTATION_BYTES,
  DEFAULT_BRIDGE_MAX_REQUEST_BYTES,
  MINIMUM_BRIDGE_MAX_REQUEST_BYTES,
  MAXIMUM_BRIDGE_MAX_REQUEST_BYTES,
  DEFAULT_DEBUGGER_COMMAND_DEADLINE_MS,
  MINIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  MAXIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  DEFAULT_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  MINIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  MAXIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS,
  MINIMUM_HOPPER_CALLER_SCAN_BUDGET_MS,
  DEFAULT_JEB_MCP_TIMEOUT_MS,
  DEFAULT_KUNA_FUNCTION_TIMEOUT_MS,
  DEFAULT_KUNA_PROJECT_TIMEOUT_MS,
  DEFAULT_PWNTOOLS_MAX_INPUT_BYTES,
  MAXIMUM_PWNTOOLS_MAX_INPUT_BYTES,
  DEFAULT_WINDOWS_CHANGE_TIME_DRIFT_MS,
  MAXIMUM_WINDOWS_CHANGE_TIME_DRIFT_MS,
  DEFAULT_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
  MAXIMUM_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
  DEFAULT_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
  MAXIMUM_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
} from "./analysisResourceLimits.js";
import {
  JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS,
  JAVASCRIPT_WORKER_HEAP_MIB_MINIMUM,
  JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM,
} from "./javascript/javascriptAnalysisResourceControls.js";
import {
  DEFAULT_WASM_COMMAND_TIMEOUT_MS,
  MAX_WASM_COMMAND_TIMEOUT_MS,
} from "./wasm/wasmArtifact.js";
interface SettingDefinition {
  readonly environment?: string;
  readonly defaultValue: number | null;
  readonly minimum: number;
  readonly maximum: number;
  readonly unit: "bytes" | "ms" | "seconds" | "MiB" | "count";
  readonly appliesAt: "next_operation" | "next_worker" | "next_startup";
  readonly updateMode: "runtime" | "restart";
  readonly provider: string;
  readonly relatedProviders?: readonly string[];
  readonly operations: readonly string[];
  readonly parameter?: string;
}
const timer = {
  minimum: 1,
  maximum: MAX_NODE_TIMER_DELAY_MS,
  unit: "ms",
  appliesAt: "next_operation",
} as const;

/** Operations that invoke Ghidra's decompiler directly or through a workflow. */
const ghidraDecompileOperations = [
  "procedure_pseudo_code",
  "analyze_function",
  "inspect_native_api",
  "decompile_all",
  "trace_native_values",
] as const;

// These operations can use the shared owned-file baseline on Windows, depending
// on their input and provider. Other workflows may also use it; this is not a
// complete reader inventory.
const windowsChangeTimeOperations = [
  "open_binary",
  "export_web_scripts",
  "capture_process_scenario",
  "compare_process_captures",
  "inspect_analysis_view",
  "compare_bundles",
  "import_evidence_bundle",
  "inspect_android_package",
  "search_android_classes",
  "inspect_android_class",
  "inspect_android_method",
  "trace_android_references",
  "inventory_artifact",
  "inspect_artifact",
  "extract_artifact",
  "inspect_binary_layout",
  "inspect_recorded_crash",
] as const;

/** Metadata aggregates existing owner definitions; no environment mutation or engine discovery. */
export const ANALYSIS_SETTINGS = {
  "ghidra.decompile_max_payload_mib": {
    updateMode: "runtime",
    environment: "REA_GHIDRA_DECOMPILE_MAX_PAYLOAD_MIB",
    defaultValue: null,
    minimum: 1,
    maximum: MAXIMUM_GHIDRA_DECOMPILE_PAYLOAD_MIB,
    unit: "MiB",
    appliesAt: "next_operation",
    provider: "ghidra",
    operations: ghidraDecompileOperations,
  },
  "asar.max_listing_bytes": {
    updateMode: "runtime",
    environment: "REA_ASAR_MAX_LISTING_BYTES",
    defaultValue: DEFAULT_ASAR_MAX_LISTING_BYTES,
    minimum: 1,
    maximum: MAXIMUM_ASAR_MAX_LISTING_BYTES,
    unit: "bytes",
    appliesAt: "next_operation",
    provider: "rea-artifact-graph",
    relatedProviders: [
      "rea-javascript-application",
      "rea-cdp-electron",
      "rea-v8-inspector",
    ],
    operations: [
      "open_binary",
      "inspect_artifact",
      "inventory_artifact",
      "extract_artifact",
      "analyze_javascript_application",
      "inspect_electron_page",
      "observe_javascript_runtime",
    ],
  },
  "ghidra.value_flow_max_operations": {
    updateMode: "runtime",
    environment: "REA_GHIDRA_VALUE_FLOW_MAX_OPERATIONS",
    defaultValue: DEFAULT_GHIDRA_VALUE_FLOW_MAX_OPERATIONS,
    minimum: 1,
    maximum: MAXIMUM_GHIDRA_VALUE_FLOW_RECORDS,
    unit: "count",
    appliesAt: "next_operation",
    provider: "ghidra",
    operations: [
      "analyze_function",
      "inspect_native_api",
      "trace_native_values",
    ],
  },
  "ghidra.value_flow_max_inputs_per_operation": {
    updateMode: "runtime",
    environment: "REA_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION",
    defaultValue: DEFAULT_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION,
    minimum: 1,
    maximum: MAXIMUM_GHIDRA_VALUE_FLOW_RECORDS,
    unit: "count",
    appliesAt: "next_operation",
    provider: "ghidra",
    operations: [
      "analyze_function",
      "inspect_native_api",
      "trace_native_values",
    ],
  },
  "ghidra.value_flow_max_edges": {
    updateMode: "runtime",
    environment: "REA_GHIDRA_VALUE_FLOW_MAX_EDGES",
    defaultValue: DEFAULT_GHIDRA_VALUE_FLOW_MAX_EDGES,
    minimum: 1,
    maximum: MAXIMUM_GHIDRA_VALUE_FLOW_RECORDS,
    unit: "count",
    appliesAt: "next_operation",
    provider: "ghidra",
    operations: [
      "analyze_function",
      "inspect_native_api",
      "trace_native_values",
    ],
  },
  "asar.max_header_bytes": {
    updateMode: "runtime",
    environment: "REA_ASAR_MAX_HEADER_BYTES",
    defaultValue: DEFAULT_ASAR_MAX_HEADER_BYTES,
    minimum: 1,
    maximum: MAXIMUM_ASAR_MAX_HEADER_BYTES,
    unit: "bytes",
    appliesAt: "next_operation",
    provider: "rea-artifact-graph",
    relatedProviders: [
      "rea-javascript-application",
      "rea-cdp-electron",
      "rea-v8-inspector",
    ],
    operations: [
      "open_binary",
      "inspect_artifact",
      "inventory_artifact",
      "extract_artifact",
      "analyze_javascript_application",
      "inspect_electron_page",
      "observe_javascript_runtime",
    ],
  },
  "ghidra.startup_timeout_ms": {
    updateMode: "runtime",
    ...timer,
    environment: "REA_GHIDRA_STARTUP_TIMEOUT_MS",
    defaultValue: DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS,
    appliesAt: "next_startup",
    provider: "ghidra",
    operations: [
      "open_binary",
      "binary_overview",
      "list_documents",
      "list_procedures",
      "search_procedures",
      "list_strings",
      "search_strings",
      "procedure_pseudo_code",
      "procedure_assembly",
      "analyze_function",
      "decompile_all",
      "trace_native_values",
    ],
  },
  "hopper.startup_timeout_ms": {
    updateMode: "runtime",
    ...timer,
    environment: "REA_HOPPER_STARTUP_TIMEOUT_MS",
    defaultValue: DEFAULT_HOPPER_STARTUP_TIMEOUT_MS,
    appliesAt: "next_startup",
    provider: "hopper",
    operations: [
      "open_binary",
      "binary_overview",
      "list_documents",
      "list_procedures",
      "search_procedures",
      "list_strings",
      "search_strings",
      "procedure_pseudo_code",
      "procedure_assembly",
      "analyze_function",
      "decompile_all",
      "trace_native_values",
    ],
  },
  "ghidra.decompile_timeout_seconds": {
    updateMode: "runtime",
    environment: "REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS",
    defaultValue: null,
    minimum: 1,
    maximum: MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS,
    unit: "seconds",
    appliesAt: "next_operation",
    provider: "ghidra",
    operations: ghidraDecompileOperations,
  },
  "jadx.operation_timeout_ms": {
    updateMode: "runtime",
    ...timer,
    environment: "REA_JADX_OPERATION_TIMEOUT_MS",
    defaultValue: DEFAULT_JADX_OPERATION_TIMEOUT_MS,
    provider: "jadx",
    operations: [
      "inspect_android_package",
      "search_android_classes",
      "inspect_android_class",
      "inspect_android_method",
      "trace_android_references",
    ],
  },
  "regex.matching_deadline_ms": {
    updateMode: "runtime",
    ...timer,
    environment: "REA_REGEX_MATCHING_DEADLINE_MS",
    defaultValue: DEFAULT_REGEX_MATCHING_DEADLINE_MS,
    maximum: MAXIMUM_REGEX_MATCHING_DEADLINE_MS,
    provider: "regex",
    relatedProviders: ["ida", "hopper", "kuna"],
    operations: ["search_strings", "search_procedures"],
  },
  "regex.worker_heap_request_mib": {
    updateMode: "runtime",
    environment: "REA_REGEX_WORKER_HEAP_REQUEST_MIB",
    defaultValue: DEFAULT_REGEX_WORKER_HEAP_REQUEST_MIB,
    minimum: MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
    maximum: MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
    unit: "MiB",
    appliesAt: "next_worker",
    provider: "regex",
    relatedProviders: ["ida", "hopper", "kuna"],
    operations: ["search_strings", "search_procedures"],
  },
  "capture.decoder_old_generation_mib": {
    updateMode: "runtime",
    environment: "REA_CAPTURE_DECODER_OLD_GENERATION_MIB",
    defaultValue: DEFAULT_CAPTURE_DECODER_OLD_GENERATION_MIB,
    minimum: CAPTURE_DECODER_SEMI_SPACE_MIB,
    maximum: MAXIMUM_CAPTURE_DECODER_OLD_GENERATION_MIB,
    unit: "MiB",
    appliesAt: "next_worker",
    provider: "capture",
    operations: ["inspect_web_network_capture"],
  },
  "javascript.analysis_timeout_ms": {
    updateMode: "runtime",
    ...timer,
    defaultValue: JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.timeoutMs,
    provider: "rea-javascript-application",
    operations: ["analyze_javascript_application"],
    parameter: "analysis_timeout_ms",
  },
  "javascript.max_heap_mb": {
    updateMode: "runtime",
    defaultValue: JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.heapMb,
    minimum: JAVASCRIPT_WORKER_HEAP_MIB_MINIMUM,
    maximum: JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM,
    unit: "MiB",
    appliesAt: "next_worker",
    provider: "rea-javascript-application",
    operations: ["analyze_javascript_application"],
    parameter: "max_heap_mb",
  },
  "wasm.command_timeout_ms": {
    updateMode: "runtime",
    ...timer,
    defaultValue: DEFAULT_WASM_COMMAND_TIMEOUT_MS,
    maximum: MAX_WASM_COMMAND_TIMEOUT_MS,
    provider: "wabt-artifact",
    operations: ["inspect_wasm_artifact"],
    parameter: "command_timeout_ms",
  },
  "native.matching_representation_bytes": {
    updateMode: "runtime",
    environment: "REA_NATIVE_MATCHING_REPRESENTATION_BYTES",
    defaultValue: DEFAULT_NATIVE_MATCHING_REPRESENTATION_BYTES,
    minimum: 1,
    maximum: MAXIMUM_NATIVE_MATCHING_REPRESENTATION_BYTES,
    unit: "bytes",
    appliesAt: "next_operation",
    provider: "rea-function-comparison",
    operations: ["match_native_functions"],
  },
  "bridge.max_request_bytes": {
    updateMode: "runtime",
    environment: "REA_BRIDGE_MAX_REQUEST_BYTES",
    defaultValue: DEFAULT_BRIDGE_MAX_REQUEST_BYTES,
    minimum: MINIMUM_BRIDGE_MAX_REQUEST_BYTES,
    maximum: MAXIMUM_BRIDGE_MAX_REQUEST_BYTES,
    unit: "bytes",
    appliesAt: "next_operation",
    provider: "hopper",
    relatedProviders: ["ghidra", "cutter"],
    // Every Hopper bridge operation, every Ghidra bridge operation, and the
    // Cutter bridge calls. bridgeMaxRequestBytes.test.ts fails when a registry
    // gains an operation that is missing here.
    operations: [
      "open_binary",
      "address_name",
      "comment",
      "current_address",
      "current_procedure",
      "current_document",
      "goto_address",
      "inline_comment",
      "list_bookmarks",
      "list_documents",
      "list_names",
      "list_procedures",
      "list_segments",
      "list_strings",
      "next_address",
      "prev_address",
      "procedure_address",
      "procedure_assembly",
      "procedure_callees",
      "procedure_callers",
      "procedure_info",
      "read_function_instructions",
      "read_bytes",
      "address_to_file_offset",
      "procedure_references",
      "procedure_pseudo_code",
      "resolve_containing_procedure",
      "search_procedures",
      "search_strings",
      "set_address_name",
      "set_addresses_names",
      "set_bookmark",
      "set_comment",
      "set_inline_comment",
      "unset_bookmark",
      "xrefs",
      "analyze_function",
      "binary_overview",
      "inspect_native_load_image",
      "search_bytes",
      "annotate_native_function",
      "inspect_native_data_type",
      "inspect_native_instruction",
      "resolve_native_call_targets",
      "list_cutter_sessions",
      "cutter_command",
    ],
  },
  "debugger.command_deadline_ms": {
    updateMode: "runtime",
    ...timer,
    environment: "REA_DEBUGGER_COMMAND_DEADLINE_MS",
    defaultValue: DEFAULT_DEBUGGER_COMMAND_DEADLINE_MS,
    minimum: MINIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
    maximum: MAXIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
    provider: "gdb",
    relatedProviders: ["rizin"],
    operations: [
      "start_gdb_session",
      "gdb_console",
      "close_gdb_session",
      "start_rizin_debug_session",
      "rizin_debug_command",
      "close_rizin_debug_session",
    ],
  },
  "debugger.max_command_output_bytes": {
    updateMode: "runtime",
    environment: "REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES",
    defaultValue: DEFAULT_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
    minimum: MINIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
    maximum: MAXIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
    unit: "bytes",
    appliesAt: "next_operation",
    provider: "gdb",
    relatedProviders: ["rizin"],
    operations: ["gdb_console", "rizin_debug_command"],
  },
  "hopper.caller_scan_budget_ms": {
    updateMode: "runtime",
    ...timer,
    environment: "REA_HOPPER_CALLER_SCAN_BUDGET_MS",
    defaultValue: DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS,
    minimum: MINIMUM_HOPPER_CALLER_SCAN_BUDGET_MS,
    provider: "hopper",
    operations: [
      "procedure_callers",
      "analyze_function",
      "procedure_references",
    ],
  },
  "jeb.mcp_timeout_ms": {
    updateMode: "runtime",
    ...timer,
    environment: "REA_JEB_MCP_TIMEOUT_MS",
    defaultValue: DEFAULT_JEB_MCP_TIMEOUT_MS,
    provider: "jeb",
    operations: [
      "inspect_jeb_client",
      "open_jeb_project",
      "list_jeb_units",
      "decompile_jeb_item",
    ],
  },
  "kuna.project_timeout_ms": {
    updateMode: "runtime",
    ...timer,
    environment: "REA_KUNA_PROJECT_TIMEOUT_MS",
    defaultValue: DEFAULT_KUNA_PROJECT_TIMEOUT_MS,
    provider: "kuna",
    operations: [
      "list_strings",
      "search_strings",
      "list_procedures",
      "search_procedures",
      "xrefs",
      "procedure_callers",
      "procedure_callees",
      "procedure_pseudo_code",
      "procedure_assembly",
      "analyze_function",
    ],
  },
  "kuna.function_timeout_ms": {
    updateMode: "runtime",
    ...timer,
    environment: "REA_KUNA_TIMEOUT_MS",
    defaultValue: DEFAULT_KUNA_FUNCTION_TIMEOUT_MS,
    provider: "kuna",
    operations: [
      "procedure_pseudo_code",
      "procedure_assembly",
      "analyze_function",
      "list_procedures",
    ],
  },
  "pwntools.max_input_bytes": {
    updateMode: "runtime",
    environment: "REA_PWNTOOLS_MAX_INPUT_BYTES",
    defaultValue: DEFAULT_PWNTOOLS_MAX_INPUT_BYTES,
    minimum: 1,
    maximum: MAXIMUM_PWNTOOLS_MAX_INPUT_BYTES,
    unit: "bytes",
    appliesAt: "next_operation",
    provider: "pwntools",
    operations: ["inspect_binary_layout", "inspect_recorded_crash"],
    parameter: "producer_limits.input_bytes",
  },
  "windows.change_time_drift_ms": {
    updateMode: "runtime",
    environment: "REA_WINDOWS_CHANGE_TIME_DRIFT_MS",
    defaultValue: DEFAULT_WINDOWS_CHANGE_TIME_DRIFT_MS,
    minimum: 1,
    maximum: MAXIMUM_WINDOWS_CHANGE_TIME_DRIFT_MS,
    unit: "ms",
    appliesAt: "next_operation",
    provider: "rea-artifact-graph",
    relatedProviders: ["jadx"],
    operations: windowsChangeTimeOperations,
  },
  "windows.change_time_settle_poll_ms": {
    updateMode: "runtime",
    environment: "REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS",
    defaultValue: DEFAULT_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
    minimum: 1,
    maximum: MAXIMUM_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
    unit: "ms",
    appliesAt: "next_operation",
    provider: "rea-artifact-graph",
    relatedProviders: ["jadx"],
    operations: windowsChangeTimeOperations,
  },
  "windows.change_time_settle_max_polls": {
    updateMode: "runtime",
    environment: "REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS",
    defaultValue: DEFAULT_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
    minimum: 1,
    maximum: MAXIMUM_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
    unit: "count",
    appliesAt: "next_operation",
    provider: "rea-artifact-graph",
    relatedProviders: ["jadx"],
    operations: windowsChangeTimeOperations,
  },
} as const satisfies Record<AnalysisSettingId, SettingDefinition>;
export const analysisSettingIds = Object.keys(
  ANALYSIS_SETTINGS,
) as AnalysisSettingId[];
export const analysisSettingIdSchema = z.enum(analysisSettingIds);
export const analysisSettingDefinition = (
  id: AnalysisSettingId,
): SettingDefinition => ANALYSIS_SETTINGS[id];
export const analysisSettingValueSchema = (id: AnalysisSettingId) => {
  const definition = analysisSettingDefinition(id);
  const number = z
    .number()
    .int()
    .min(definition.minimum)
    .max(definition.maximum);
  return id === "ghidra.decompile_timeout_seconds" ||
    id === "ghidra.decompile_max_payload_mib"
    ? number.nullable()
    : number;
};
/**
 * Caller argument, then the accepted runtime override, then the built-in
 * default. The third value is that default, not a launch-environment seed.
 */
export const selectedAnalysisSetting = (
  request: number | undefined,
  override: number | undefined,
  fallback: number,
): {
  readonly value: number;
  readonly source: "default" | "runtime" | "request";
} => {
  if (request !== undefined) return { value: request, source: "request" };
  if (override !== undefined) return { value: override, source: "runtime" };
  return { value: fallback, source: "default" };
};

/** Project one owner's accepted budget, including the explicit per-call precedence. */
export const analysisSettingLimit = (
  setting: AnalysisSettingId,
  effective_value: number | null,
  source: AnalysisSettingLimit["source"],
): AnalysisSettingLimit => {
  const definition = analysisSettingDefinition(setting);
  return {
    setting,
    effective_value,
    ...(source === undefined ? {} : { source }),
    unit: definition.unit,
    minimum: definition.minimum,
    maximum: definition.maximum,
    applies_at: definition.appliesAt,
    agent_editable: true,
    scope: "rea-runtime",
    update_mode: source === "request" ? "parameter" : definition.updateMode,
    pending_restart: false,
    ...(definition.parameter === undefined
      ? {}
      : { parameter: definition.parameter }),
  };
};

/** Re-scope an enforced limit for a caller whose runtime ended with this invocation. */
export const invocationSettingLimit = ({
  applies_at: _appliesAt,
  scope: _scope,
  ...facts
}: AnalysisSettingLimit): AnalysisInvocationSettingLimit => {
  const environment = analysisSettingDefinition(facts.setting).environment;
  return {
    ...facts,
    applies_at: "next_invocation",
    scope: "rea-invocation",
    ...(environment === undefined ? {} : { environment }),
  };
};
