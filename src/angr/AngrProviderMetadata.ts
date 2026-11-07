import type { AnalysisOperation } from "../application/AnalysisProvider.js";

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
