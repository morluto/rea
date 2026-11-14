import type {
  AnalysisOperation,
  CapabilityDescriptor,
} from "../application/AnalysisProvider.js";

/** This version identifies REA's adapter, not Binary Ninja or its MCP server. */
export const BINARY_NINJA_PROVIDER_IDENTITY = Object.freeze({
  id: "binary-ninja",
  name: "Binary Ninja MCP adapter",
  version: "1",
});

/** Read-only analyst outcomes served from Binary Ninja's built-in GUI MCP server. */
export const BINARY_NINJA_OPERATIONS = Object.freeze([
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
  "list_documents",
] as const satisfies readonly Exclude<AnalysisOperation, "health">[]);
export type BinaryNinjaOperation = (typeof BINARY_NINJA_OPERATIONS)[number];

/** Shared limitations of observations from a live, externally editable GUI analysis. */
export const BINARY_NINJA_LIMITATIONS = Object.freeze([
  "Provider version identifies the REA Binary Ninja adapter. The Binary Ninja build is unknown; MCP serverInfo is reported separately.",
  "Results describe the current Binary Ninja analysis of the open file. The Raw view digest binds the loaded bytes to the selected target, but user annotations, analysis settings, and analysis completeness remain unknown.",
  "Live results are never replayed from analysis snapshots. View checks before and after a request do not lock the GUI against external changes.",
  "REA selects the target's BinaryView as the MCP server's active view. That selection is shared by every MCP client of the same Binary Ninja instance.",
  "Binary Ninja MCP does not pass cancellation to its tools; a cancelled REA request stops waiting but does not interrupt Binary Ninja work already started.",
  "Complete function body ranges, typed references, comments, referenced data, and basic blocks are unavailable in this adapter. Empty unsupported dossier facets are unknown, not observed absence.",
]);

/** Binary Ninja's code references are exposed only for function entries. */
export const BINARY_NINJA_XREF_LIMITATION =
  "Binary Ninja MCP exposes code references only into function entries. References into other addresses include data references only; additional code references remain unknown.";

/** Advertise live observations and their effects truthfully. */
export const binaryNinjaCapabilities = (): readonly CapabilityDescriptor[] =>
  BINARY_NINJA_OPERATIONS.map((operation) => ({
    provider: BINARY_NINJA_PROVIDER_IDENTITY,
    operation,
    available: true,
    reason: null,
    cachePolicy: "live",
    effects: {
      mutatesArtifact: false,
      launchesProcess: false,
      mayShowUi: false,
      mayAccessNetwork: true,
      mayWriteFilesystem: false,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations:
      operation === "xrefs"
        ? [...BINARY_NINJA_LIMITATIONS, BINARY_NINJA_XREF_LIMITATION]
        : BINARY_NINJA_LIMITATIONS,
  }));
