import type {
  AnalysisOperation,
  CapabilityDescriptor,
} from "../application/AnalysisProvider.js";

/** This version identifies REA's adapter, not angr or its MCP server. */
export const ANGR_PROVIDER_IDENTITY = Object.freeze({
  id: "angr",
  name: "angr MCP adapter",
  version: "1",
});

/** Read-only analyst outcomes served by angr's bundled MCP server. */
export const ANGR_OPERATIONS = Object.freeze([
  "list_procedures",
  "search_procedures",
  "list_strings",
  "search_strings",
  "procedure_address",
  "procedure_pseudo_code",
  "procedure_assembly",
  "procedure_callers",
  "procedure_callees",
  "read_function_instructions",
  "xrefs",
  "analyze_function",
  "set_address_name",
  "set_addresses_names",
  "set_comment",
  "annotate_native_function",
  "rename_native_variables",
  "set_native_variable_types",
  "set_native_function_prototypes",
  "inspect_native_decompilation_flavor",
  "set_native_decompilation_flavor",
] as const satisfies readonly Exclude<AnalysisOperation, "health">[]);
export type AngrOperation = (typeof ANGR_OPERATIONS)[number];

/** Operations that edit the upstream knowledge base for this session's project. */
export const ANGR_MUTATING_OPERATIONS: ReadonlySet<string> =
  new Set<AngrOperation>([
    "set_address_name",
    "set_addresses_names",
    "set_comment",
    "annotate_native_function",
    "rename_native_variables",
    "set_native_variable_types",
    "set_native_function_prototypes",
    "set_native_decompilation_flavor",
  ]);

/** Upstream tools the decompilation-flavor operations need; absent on older angr releases. */
export const ANGR_FLAVOR_TOOLS = Object.freeze([
  "get_decompilation_flavor",
  "set_decompilation_flavor",
]);

/** Tools the upstream angr MCP server must advertise for this adapter. */
export const ANGR_REQUIRED_TOOLS = Object.freeze([
  "load_binary",
  "get_cfg",
  "list_functions",
  "get_function_info",
  "decompile_function",
  "get_xrefs",
  "get_strings",
  "get_basic_blocks",
  "get_callgraph",
  "close_project",
  "rename",
  "set_type",
  "set_comments",
]);

/** Shared limitations of observations from a static angr analysis session. */
export const ANGR_LIMITATIONS = Object.freeze([
  "Provider version identifies the REA angr adapter. The angr engine version is reported from MCP serverInfo only when upstream declares it.",
  "Results describe angr's static CFGFast recovery of the selected binary without loading shared libraries. Functions reached only through unresolved indirect control flow, and code angr classifies as data, remain unknown.",
  "Call relationships come from angr's recovered call graph. Unresolved indirect calls are absent, so an empty caller or callee list does not prove isolation.",
  "Live results are never replayed from analysis snapshots. An attached server is shared with other clients, so results reflect its current knowledge base, including renames applied by other agents.",
  "Caller cancellation drains the in-flight MCP request before cleanup; it does not prove that angr analysis work was interrupted.",
  "Typed reference flags, comments, referenced strings and names, and basic-block successors are unavailable in this adapter. Empty unsupported dossier facets are unknown, not observed absence.",
]);

export const ANGR_EDIT_LIMITATIONS = Object.freeze([
  "Edits change angr's knowledge base for this session's project only; original executable bytes are never written and nothing persists after close_project.",
  "angr keeps one comment store that it mirrors next to the matching pseudocode statement; inline comments are not distinct, and a comment at a non-statement address is snapped down to the nearest statement boundary.",
  "Batch edits are not transactional: items already applied stay applied when a later item fails. Use dry_run as a pre-flight.",
]);

/** Advertise static observations and configured lifecycle effects truthfully. */
export const angrCapabilities = (
  mode: "attached" | "headless",
): readonly CapabilityDescriptor[] =>
  ANGR_OPERATIONS.map((operation) => ({
    provider: ANGR_PROVIDER_IDENTITY,
    operation,
    available: true,
    reason: null,
    cachePolicy: "live",
    effects: {
      mutatesArtifact: ANGR_MUTATING_OPERATIONS.has(operation),
      launchesProcess: mode === "headless",
      mayShowUi: false,
      mayAccessNetwork: mode === "attached",
      mayWriteFilesystem: mode === "headless",
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: ANGR_MUTATING_OPERATIONS.has(operation)
      ? [...ANGR_LIMITATIONS, ...ANGR_EDIT_LIMITATIONS]
      : ANGR_LIMITATIONS,
  }));
