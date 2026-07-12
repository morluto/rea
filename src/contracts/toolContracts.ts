import { z } from "zod";

import { enhancedInputSchemas } from "./enhancedInputs.js";
import {
  enhancedOutputSchemas,
  officialOutputSchemas,
  sessionOutputSchemas,
} from "./toolOutputSchemas.js";

const document = z.string().optional().describe("The document name");
const address = z.string().describe("A Hopper address");
const optionalAddress = address.optional();
const procedure = z.string().describe("The procedure name or address");
const pattern = z.string().describe("The regex pattern to search for");
const caseSensitive = z
  .boolean()
  .default(false)
  .describe("Whether to match case");
const pagination = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
};

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: true;
  readonly openWorldHint: false;
}

/** Adapter family responsible for implementing a public MCP tool. */
type ToolKind = "official-proxy" | "enhanced" | "session";

/** Single source of truth for a public tool's name, description, and input. */
export interface ToolContract {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodObject;
  readonly annotations: ToolAnnotations;
}

const annotations = (name: string, kind: ToolKind): ToolAnnotations => ({
  readOnlyHint:
    kind === "enhanced" ||
    (!name.startsWith("set_") &&
      name !== "unset_bookmark" &&
      name !== "goto_address" &&
      kind !== "session"),
  destructiveHint:
    name === "unset_bookmark" ||
    name === "set_address_name" ||
    name === "set_addresses_names" ||
    name === "set_comment" ||
    name === "set_inline_comment",
  idempotentHint: true,
  openWorldHint: false,
});

const official = (
  name: string,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract => ({
  name,
  description,
  kind: "official-proxy",
  inputSchema,
  outputSchema: requireOutputSchema(officialOutputSchemas, name),
  annotations: annotations(name, "official-proxy"),
});

const enhanced = (
  name: string,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract => ({
  name,
  description,
  kind: "enhanced",
  inputSchema,
  outputSchema: requireOutputSchema(enhancedOutputSchemas, name),
  annotations: annotations(name, "enhanced"),
});

const session = (
  name: string,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract => ({
  name,
  description,
  kind: "session",
  inputSchema,
  outputSchema: requireOutputSchema(sessionOutputSchemas, name),
  annotations: annotations(name, "session"),
});

const requireOutputSchema = (
  schemas: Readonly<Record<string, z.ZodObject>>,
  name: string,
): z.ZodObject => {
  const schema = schemas[name];
  if (schema === undefined)
    throw new Error(`Missing output schema for ${name}`);
  return schema;
};

/** Bridge operations exposed without additional application composition. */
export const OFFICIAL_TOOL_CONTRACTS = [
  official(
    "address_name",
    "Resolve the analyzed name at a code or data address, defaulting to Hopper's current cursor. Use before following a symbol into xrefs; null means Hopper has no name at that address.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "comment",
    "Read the regular analysis comment at an address, defaulting to the current cursor. This is read-only and returns null when no comment exists; use set_comment to persist a finding.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "current_address",
    "Return Hopper's current cursor address for the selected document. Use only for interactive navigation state; prefer explicit addresses in reproducible investigations.",
    z.object({ document }),
  ),
  official(
    "current_procedure",
    "Return the analyzed procedure containing Hopper's current cursor. Use procedure_info or analyze_function next; this depends on GUI cursor state and is not an exhaustive lookup.",
    z.object({ document }),
  ),
  official(
    "current_document",
    "Return the document currently selected by REA's Hopper bridge. Use list_documents before switching when several documents are open.",
    z.object({}),
  ),
  official(
    "goto_address",
    "Move Hopper's GUI cursor to a hexadecimal address and return the resolved address. This changes navigation state but not analysis data; use explicit-address tools for headless workflows.",
    z.object({ address, document }),
  ),
  official(
    "inline_comment",
    "Read the inline instruction comment at an address, defaulting to the current cursor. Returns null when absent; use set_inline_comment to write one.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "list_bookmarks",
    "List every bookmark in the selected Hopper document as address and name pairs. Use bookmarks as analyst-authored navigation aids; this does not discover code references.",
    z.object({ document }),
  ),
  official(
    "list_documents",
    "List all Hopper documents visible to the bridge. Use before set_current_document when a provider session contains multiple documents.",
    z.object({}),
  ),
  official(
    "list_names",
    "Page through analyzed names as address/value pairs. Results are bounded by offset and limit; follow next_offset until has_more is false before claiming exhaustive symbol coverage.",
    z.object({ document, address: optionalAddress, ...pagination }),
  ),
  official(
    "list_procedures",
    "Page through analyzed procedures as address/value pairs. Wait for Hopper analysis first, then follow next_offset for exhaustive coverage; use returned addresses with analyze_function or procedure_pseudo_code.",
    z.object({ document, ...pagination }),
  ),
  official(
    "list_segments",
    "List all segments and sections in the selected document. Hopper's public API does not expose permissions, so writable and executable are null with explicit capability metadata.",
    z.object({ document }),
  ),
  official(
    "list_strings",
    "Page through analyzed strings, or filter to one address, as address/value pairs. Follow next_offset for exhaustive results and use xrefs on interesting string addresses.",
    z.object({ document, address: optionalAddress, ...pagination }),
  ),
  official(
    "next_address",
    "Return the next analyzed object address after an explicit address or current cursor. This is a navigation primitive, not instruction-flow or CFG analysis.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "prev_address",
    "Return the previous analyzed instruction start before an explicit address or current cursor. This is a navigation primitive and may fail at document boundaries.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "procedure_address",
    "Resolve a procedure symbol name or hexadecimal address to its entry address. Use this to canonicalize user-supplied identifiers before xrefs, assembly, or decompilation.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_assembly",
    "Return assembly for one analyzed procedure identified by symbol or hexadecimal address. Use when pseudocode loses calling-convention or instruction-level detail; output is currently returned as one unpaginated string.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_callees",
    "Return Hopper's analyzed direct callees for one procedure identified by symbol or address. Indirect calls may be absent; use analyze_function and xrefs to corroborate the call path.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_callers",
    "Return Hopper's analyzed direct callers for one procedure identified by symbol or address. Results reflect completed static analysis and may omit indirect references.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_info",
    "Return bounded metadata for one procedure identified by symbol or address: entrypoint, signature, locals, size, and block count. Follow with decompilation or assembly for behavior.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_references",
    "Return a bounded set of raw incoming or outgoing reference edges for one procedure. Endpoint procedures are resolved only when Hopper reports containment; reference kinds remain explicitly unavailable.",
    z.object({
      procedure,
      direction: z.enum(["incoming", "outgoing"]).default("outgoing"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
      max_instructions: z.number().int().min(1).max(5000).default(500),
      document,
    }),
  ),
  official(
    "procedure_pseudo_code",
    "Decompile one analyzed procedure by symbol name or hexadecimal address. Returns Hopper pseudocode, not original source, and may return null; request procedure_assembly when instruction precision matters.",
    z.object({ procedure, document }),
  ),
  official(
    "resolve_containing_procedure",
    "Resolve an arbitrary address, including an xref source or interior instruction, to its Hopper-analyzed containing procedure. A negative result includes an explicit reason and is not guessed from nearby symbols.",
    z.object({ address, document }),
  ),
  official(
    "search_procedures",
    "Regex-search all analyzed procedure names with optional case sensitivity. The current bridge returns an unpaginated address/name map, so constrain patterns and use list_procedures for controlled exhaustive traversal.",
    z.object({ pattern, case_sensitive: caseSensitive, document }),
  ),
  official(
    "search_strings",
    "Regex-search all analyzed strings with optional case sensitivity. The current bridge is unpaginated and evaluates Python regex, so use narrow patterns and follow matches with xrefs.",
    z.object({ pattern, case_sensitive: caseSensitive, document }),
  ),
  official(
    "set_address_name",
    "Assign an analyst name to one hexadecimal address and report Hopper's boolean result. This mutates analysis metadata; read it back with address_name before relying on it.",
    z.object({ address, name: z.string(), document }),
  ),
  official(
    "set_addresses_names",
    "Assign analyst names to an address/name map and return per-address success booleans. This mutates analysis metadata; use for bounded batches and verify failures individually.",
    z.object({ names: z.record(z.string(), z.string()), document }),
  ),
  official(
    "set_bookmark",
    "Create or replace a bookmark at a hexadecimal address. This mutates navigation metadata; verify with list_bookmarks and do not treat bookmarks as binary evidence.",
    z.object({ address, name: z.string().optional(), document }),
  ),
  official(
    "set_comment",
    "Write a regular analysis comment at a hexadecimal address and return whether readback matched. This mutates the Hopper document; use comments to record evidence IDs or reasoning.",
    z.object({ address, comment: z.string(), document }),
  ),
  official(
    "set_current_document",
    "Select an already-open Hopper document by exact document name. This changes subsequent default-document routing; call list_documents first and prefer explicit document inputs where reproducibility matters.",
    z.object({ document: z.string() }),
  ),
  official(
    "set_inline_comment",
    "Write an inline instruction comment at a hexadecimal address and return whether readback matched. This mutates analysis metadata; confirm with inline_comment.",
    z.object({ address, comment: z.string(), document }),
  ),
  official(
    "unset_bookmark",
    "Remove the bookmark at a hexadecimal address and return whether it is absent. This mutates navigation metadata and does not alter binary bytes.",
    z.object({ address, document }),
  ),
  official(
    "xrefs",
    "Return analyzed references to a code or data address, defaulting to the current cursor. Use to connect strings, globals, selectors, and functions; bare addresses are untyped and indirect references may be incomplete.",
    z.object({ document, address: optionalAddress }),
  ),
] as const satisfies readonly ToolContract[];

/** Bounded workflows composed from one or more bridge operations. */
export const ENHANCED_TOOL_CONTRACTS = [
  enhanced(
    "swift_classes",
    "Discover legacy-mangled Swift class procedures after exhaustively paging analyzed procedures. Returns at most 100 entries and scans at most 5,000 symbols; use analyze_swift_types for other Swift kinds.",
    enhancedInputSchemas.swift_classes,
  ),
  enhanced(
    "get_objc_classes",
    "Discover and deduplicate Objective-C class labels after exhaustively paging names, optionally filtering by literal substring. Returns at most 100 classes; inspect matching metadata and references next.",
    enhancedInputSchemas.get_objc_classes,
  ),
  enhanced(
    "get_objc_protocols",
    "Discover and deduplicate Objective-C and Swift protocol labels after exhaustively paging names. Returns at most 100 entries; use xrefs or analyze_function to connect a protocol to implementations.",
    enhancedInputSchemas.get_objc_protocols,
  ),
  enhanced(
    "batch_decompile",
    "Decompile up to 20 explicit procedure symbols or addresses concurrently. Per-item strings may contain errors or no-output markers, so validate each result; use analyze_function for a richer single-function dossier.",
    enhancedInputSchemas.batch_decompile,
  ),
  enhanced(
    "get_call_graph",
    "Traverse Hopper's caller or callee relationships from one symbol or address for at most five levels. Nodes preserve per-procedure errors; indirect calls may be missing and results are not a whole-program CFG.",
    enhancedInputSchemas.get_call_graph,
  ),
  enhanced(
    "analyze_swift_types",
    "Categorize exhaustively paged procedure names into Swift classes, structs, enums, protocols, extensions, and other symbols. Scans at most 5,000 names and returns at most 50 entries per category.",
    enhancedInputSchemas.analyze_swift_types,
  ),
  enhanced(
    "find_xrefs_to_name",
    "Resolve a name through Hopper and return analyzed references to its address. Use when starting from a selector or symbol; resolution failure is returned explicitly and xrefs remain untyped.",
    enhancedInputSchemas.find_xrefs_to_name,
  ),
  enhanced(
    "binary_overview",
    "Use immediately after opening a target to summarize document, exhaustive procedure/string counts, and a bounded segment sample. detail controls segment fields and limit controls only the returned segment sample.",
    enhancedInputSchemas.binary_overview,
  ),
  enhanced(
    "analyze_function",
    "Preferred bounded analysis for one procedure symbol or address. Returns identity, pseudocode, optional assembly, comments, calls, incoming references, and blocks; unsupported outgoing references and CFG edges carry explicit unavailable metadata.",
    enhancedInputSchemas.analyze_function,
  ),
  enhanced(
    "trace_feature",
    "Trace a bounded literal feature query through matching strings and procedures, xrefs, and truthful containing-procedure resolution. Returns the operation budget, truncation, and residual unknowns; it does not infer reference kinds.",
    enhancedInputSchemas.trace_feature,
  ),
] as const satisfies readonly ToolContract[];

/** Target lifecycle tools available only on the long-lived MCP adapter. */
export const SESSION_TOOL_CONTRACTS = [
  session(
    "open_binary",
    "Open a local executable, application bundle, or Hopper database, replacing the active target only after validation. This launches Hopper and may show UI; call binary_overview after success.",
    z.object({ path: z.string().min(1) }),
  ),
  session(
    "close_binary",
    "Close the active Hopper-backed target and release its provider process. The operation is idempotent; call binary_session to verify the session is closed.",
    z.object({}),
  ),
  session(
    "binary_session",
    "Report whether a target is open and, when open, its canonical path, format, and kind. Use before analysis calls or target switches; this performs no analysis.",
    z.object({}),
  ),
] as const satisfies readonly ToolContract[];

/**
 * Complete ordered public inventory used by registration and verification.
 * Keep this collection at 46 tools unless a deliberate contract change updates
 * snapshots, package verification, and real-Hopper verification together.
 */
export const TOOL_CONTRACTS = [
  ...OFFICIAL_TOOL_CONTRACTS,
  ...ENHANCED_TOOL_CONTRACTS,
  ...SESSION_TOOL_CONTRACTS,
] as const;
