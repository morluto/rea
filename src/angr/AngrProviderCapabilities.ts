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
] as const satisfies readonly Exclude<AnalysisOperation, "health">[]);
export type AngrOperation = (typeof ANGR_OPERATIONS)[number];

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
      mutatesArtifact: false,
      launchesProcess: mode === "headless",
      mayShowUi: false,
      mayAccessNetwork: mode === "attached",
      mayWriteFilesystem: mode === "headless",
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: ANGR_LIMITATIONS,
  }));
