import type { AnalysisOperation } from "../application/AnalysisProvider.js";

/** This version identifies REA's adapter, not IDA or the upstream MCP server. */
export const IDA_PROVIDER_IDENTITY = Object.freeze({
  id: "ida",
  name: "IDA MCP adapter",
  version: "1",
});

/** Read-only analyst outcomes supported by the upstream compatibility profiles. */
export const IDA_OPERATIONS = Object.freeze([
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
  "resolve_containing_procedure",
  "list_documents",
] as const satisfies readonly Exclude<AnalysisOperation, "health">[]);
