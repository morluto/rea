import { z } from "zod";

import { enhancedInputSchemas } from "./enhancedInputs.js";

const document = z.string().optional().describe("The document name");
const address = z.string().describe("A Hopper address");
const optionalAddress = address.optional();
const procedure = z.string().describe("The procedure name or address");
const pattern = z.string().describe("The regex pattern to search for");
const caseSensitive = z
  .boolean()
  .default(false)
  .describe("Whether to match case");

/** The architectural owner of a tool implementation. */
export type ToolKind = "official-proxy" | "enhanced" | "session";

/** Stable caller-visible contract retained across the Python-to-TypeScript migration. */
export interface ToolContract {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodObject;
}

const official = (
  name: string,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract => ({ name, description, kind: "official-proxy", inputSchema });

const enhanced = (
  name: string,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract => ({ name, description, kind: "enhanced", inputSchema });

const session = (
  name: string,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract => ({ name, description, kind: "session", inputSchema });

/** All 31 tools forwarded unchanged to Hopper's official MCP server. */
export const OFFICIAL_TOOL_CONTRACTS = [
  official(
    "address_name",
    "Get the name at an address",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "comment",
    "Get the comment at an address",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "current_address",
    "Get the current address",
    z.object({ document }),
  ),
  official(
    "current_procedure",
    "Get the current procedure",
    z.object({ document }),
  ),
  official("current_document", "Get the current document", z.object({})),
  official(
    "goto_address",
    "Navigate to an address",
    z.object({ address, document }),
  ),
  official(
    "inline_comment",
    "Get the inline comment at an address",
    z.object({ document, address: optionalAddress }),
  ),
  official("list_bookmarks", "List bookmarks", z.object({ document })),
  official("list_documents", "List open documents", z.object({})),
  official(
    "list_names",
    "List names",
    z.object({ document, address: optionalAddress }),
  ),
  official("list_procedures", "List procedures", z.object({ document })),
  official("list_segments", "List segments", z.object({ document })),
  official(
    "list_strings",
    "List strings",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "next_address",
    "Get the next address",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "prev_address",
    "Get the previous address",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "procedure_address",
    "Resolve a procedure address",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_assembly",
    "Get procedure assembly",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_callees",
    "List procedure callees",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_callers",
    "List procedure callers",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_info",
    "Get procedure metadata",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_pseudo_code",
    "Decompile a procedure",
    z.object({ procedure, document }),
  ),
  official(
    "search_procedures",
    "Search procedure names",
    z.object({ pattern, case_sensitive: caseSensitive, document }),
  ),
  official(
    "search_strings",
    "Search strings",
    z.object({ pattern, case_sensitive: caseSensitive, document }),
  ),
  official(
    "set_address_name",
    "Set an address name",
    z.object({ address, name: z.string(), document }),
  ),
  official(
    "set_addresses_names",
    "Set multiple address names",
    z.object({ names: z.record(z.string(), z.string()), document }),
  ),
  official(
    "set_bookmark",
    "Set a bookmark",
    z.object({ address, name: z.string().optional(), document }),
  ),
  official(
    "set_comment",
    "Set an address comment",
    z.object({ address, comment: z.string(), document }),
  ),
  official(
    "set_current_document",
    "Select the current document",
    z.object({ document: z.string() }),
  ),
  official(
    "set_inline_comment",
    "Set an inline comment",
    z.object({ address, comment: z.string(), document }),
  ),
  official(
    "unset_bookmark",
    "Remove a bookmark",
    z.object({ address, document }),
  ),
  official(
    "xrefs",
    "Get cross-references to an address",
    z.object({ document, address: optionalAddress }),
  ),
] as const satisfies readonly ToolContract[];

/** All 8 reverse-engineering tools implemented by REA. */
export const ENHANCED_TOOL_CONTRACTS = [
  enhanced(
    "swift_classes",
    "Discover Swift classes",
    enhancedInputSchemas.swift_classes,
  ),
  enhanced(
    "get_objc_classes",
    "Discover Objective-C classes",
    enhancedInputSchemas.get_objc_classes,
  ),
  enhanced(
    "get_objc_protocols",
    "Discover Objective-C protocols",
    enhancedInputSchemas.get_objc_protocols,
  ),
  enhanced(
    "batch_decompile",
    "Decompile up to 20 procedures",
    enhancedInputSchemas.batch_decompile,
  ),
  enhanced(
    "get_call_graph",
    "Traverse a bounded call graph",
    enhancedInputSchemas.get_call_graph,
  ),
  enhanced(
    "analyze_swift_types",
    "Categorize Swift mangled names",
    enhancedInputSchemas.analyze_swift_types,
  ),
  enhanced(
    "find_xrefs_to_name",
    "Find cross-references by name",
    enhancedInputSchemas.find_xrefs_to_name,
  ),
  enhanced(
    "binary_overview",
    "Summarize the loaded binary",
    enhancedInputSchemas.binary_overview,
  ),
] as const satisfies readonly ToolContract[];

/** Binary lifecycle tools available before Hopper is launched. */
export const SESSION_TOOL_CONTRACTS = [
  session(
    "open_binary",
    "Open or switch the active binary",
    z.object({ path: z.string().min(1) }),
  ),
  session("close_binary", "Close the active binary", z.object({})),
  session("binary_session", "Describe the active binary session", z.object({})),
] as const satisfies readonly ToolContract[];

/** Complete caller-visible tool inventory. */
export const TOOL_CONTRACTS = [
  ...OFFICIAL_TOOL_CONTRACTS,
  ...ENHANCED_TOOL_CONTRACTS,
  ...SESSION_TOOL_CONTRACTS,
] as const;
