import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  processCaptureSchema,
  processScenarioSchema,
} from "../domain/processCapture.js";
import {
  recordUnknownInputSchema,
  updateUnknownInputSchema,
} from "../domain/residualUnknown.js";
import { artifactComparisonInputSchema } from "../domain/artifactComparison.js";
import { functionComparisonInputSchema } from "../domain/functionComparison.js";
import { bundleComparisonInputSchema } from "../domain/bundleComparison.js";
import { changedBehaviorInputSchema } from "../domain/changedBehavior.js";
import { callPathInputSchema } from "../domain/callPath.js";
import { staticRuntimeCorrelationInputSchema } from "../domain/staticRuntimeCorrelation.js";
import { reconstructionVerificationInputSchema } from "../domain/reconstructionVerification.js";

import { enhancedInputSchemas } from "./enhancedInputs.js";
import {
  enhancedOutputSchemas,
  officialOutputSchemas,
  requireOutputSchema,
  sessionOutputSchemas,
} from "./toolOutputSchemas.js";
import { TOOL_EXAMPLE_OVERRIDES } from "./toolContractExamples.js";
import { NATIVE_TOOL_CONTRACTS } from "./nativeToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "./artifactToolContracts.js";

const document = z.string().optional().describe("The document name");
const address = z.string().describe("A Hopper address");
const optionalAddress = address.optional();
const procedure = z.string().describe("The procedure name or address");
const searchPattern = z
  .string()
  .min(1)
  .max(256)
  .describe("The literal text or bounded regex pattern to search for");
const caseSensitive = z
  .boolean()
  .default(false)
  .describe("Whether to match case");
const pagination = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
};
const searchInput = {
  pattern: searchPattern,
  mode: z.enum(["literal", "regex"]).default("literal"),
  case_sensitive: caseSensitive,
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(100),
  document,
};

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolExample {
  readonly title: string;
  readonly input: Readonly<Record<string, JsonValue>>;
}

/** Adapter family responsible for implementing a public MCP tool. */
type ToolKind =
  | "official-proxy"
  | "enhanced"
  | "native-provider"
  | "artifact-provider"
  | "session";

/** Single source of truth for a public tool's name, description, and input. */
export interface ToolContract<Name extends string = string> {
  readonly name: Name;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodObject;
  readonly annotations: ToolAnnotations;
  readonly examples: readonly ToolExample[];
}

const exampleInputSchema = z.record(z.string(), jsonValueSchema);
const examplesFor = (
  name: string,
  inputSchema: z.ZodObject,
): readonly ToolExample[] => {
  const parsed = inputSchema.parse(TOOL_EXAMPLE_OVERRIDES[name] ?? {});
  return [
    {
      title: `Example ${name.replaceAll("_", " ")} request`,
      input: exampleInputSchema.parse(parsed),
    },
  ];
};

const annotations = (name: string, kind: ToolKind): ToolAnnotations => ({
  readOnlyHint:
    (kind === "enhanced" && name !== "trace_feature") ||
    name === "binary_session" ||
    name === "list_unknowns" ||
    name === "verify_unknown_resolution",
  destructiveHint:
    name === "export_evidence_bundle" ||
    name === "unset_bookmark" ||
    name === "set_address_name" ||
    name === "set_addresses_names" ||
    name === "set_comment" ||
    name === "set_inline_comment",
  idempotentHint: name !== "record_unknown" && name !== "update_unknown",
  openWorldHint: name === "capture_process_scenario",
});

const official = <Name extends string>(
  name: Name,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract<Name> => {
  const trackedInputSchema = inputSchema.extend({
    unknown_registry_approved: z
      .literal(true)
      .optional()
      .describe(
        "Explicit approval to record typed capability unavailability as a residual unknown",
      ),
  });
  return {
    name,
    description,
    kind: "official-proxy",
    inputSchema: trackedInputSchema,
    outputSchema: requireOutputSchema(officialOutputSchemas, name),
    annotations: annotations(name, "official-proxy"),
    examples: examplesFor(name, trackedInputSchema),
  };
};

const enhanced = <Name extends string>(
  name: Name,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract<Name> => ({
  name,
  description,
  kind: "enhanced",
  inputSchema,
  outputSchema: requireOutputSchema(enhancedOutputSchemas, name),
  annotations: annotations(name, "enhanced"),
  examples: examplesFor(name, inputSchema),
});

const session = <Name extends string>(
  name: Name,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract<Name> => ({
  name,
  description,
  kind: "session",
  inputSchema,
  outputSchema: requireOutputSchema(sessionOutputSchemas, name),
  annotations: annotations(name, "session"),
  examples: examplesFor(name, inputSchema),
});

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
    "Search analyzed procedure names using literal matching by default or a structurally bounded regex. Returns a deterministic, offset-paginated page; continue at next_offset while has_more is true.",
    z.object(searchInput),
  ),
  official(
    "search_strings",
    "Search analyzed strings using literal matching by default or a structurally bounded regex. Returns a deterministic, offset-paginated page with explicit value truncation; follow matches with xrefs.",
    z.object(searchInput),
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

/** Closed provider operation names exposed by direct analysis adapters. */
export type OfficialToolName = (typeof OFFICIAL_TOOL_CONTRACTS)[number]["name"];

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
    "Trace a bounded literal feature query through matching strings and procedures, xrefs, and truthful containing-procedure resolution. Returns the operation budget, truncation, and residual unknowns; unknown_registry_approved: true records them durably without inferring reference kinds.",
    enhancedInputSchemas.trace_feature,
  ),
] as const satisfies readonly ToolContract[];

/** Target lifecycle tools available only on the long-lived MCP adapter. */
export const SESSION_TOOL_CONTRACTS = [
  session(
    "open_binary",
    "Open a local executable, application bundle, archive, JavaScript, source map, plist, or Hopper database after validation. Providers start lazily: inventory_artifact does not launch Hopper; deep native operations may show Hopper UI.",
    z.object({ path: z.string().min(1) }),
  ),
  session(
    "close_binary",
    "Close the active target and every provider resource started for it. The operation is idempotent; call binary_session to verify the session is closed.",
    z.object({}),
  ),
  session(
    "binary_session",
    "Report provider identity, deterministic capability descriptors, and whether a target is open; open targets include canonical path, format, and kind. Use availability, effects, limits, and limitations before selecting analysis operations.",
    z.object({}),
  ),
  session(
    "export_evidence_bundle",
    "Return the session's deterministic Evidence v2 bundle, or atomically write it beneath an operator-approved root. Existing files require overwrite: true; records and manifests use canonical byte-stable ordering.",
    z.object({
      path: z.string().min(1).optional(),
      overwrite: z.boolean().default(false),
    }),
  ),
  session(
    "import_evidence_bundle",
    "Read a bounded local JSON bundle beneath an operator-approved root, validate every Evidence v2 ID and canonical manifest, then atomically merge it. Imported content is data only and is never executed.",
    z.object({ path: z.string().min(1) }),
  ),
  session(
    "capture_process_scenario",
    "Run one bounded process under a PTY using operator-approved executable and working roots. Requires approved: true; unknown_registry_approved: true separately records capture residuals. Captures normalized terminal frames, descendants, filesystem snapshots, and loopback replay. Disabled unless operator policy enables it; not a security sandbox.",
    processScenarioSchema,
  ),
  session(
    "compare_process_captures",
    "Compare two bounded process captures across terminal, exit, sampled process, filesystem, HTTP, and WebSocket evidence. Missing or truncated observations are never treated as equivalent.",
    z.object({
      left_evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
      left: processCaptureSchema,
      right_evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
      right: processCaptureSchema,
      unknown_registry_approved: z
        .literal(true)
        .optional()
        .describe("Explicit approval to record capture disagreement durably"),
    }),
  ),
  session(
    "compare_artifacts",
    "Compare two bounded sets of inventory_artifact Evidence pages by logical occurrence path, content identity, metadata, and graph relations. Pages must share and satisfy their graph commitment; every delta cites both sets, and gaps yield truncated or unknown, never equivalence.",
    artifactComparisonInputSchema,
  ),
  session(
    "compare_functions",
    "Compare two explicit bounded sets of analyze_function Evidence pages across identity, exact provider text, calls, references, strings, and address-normalized CFG topology. Missing or provider-incompatible facets remain truncated or unknown; every conclusion cites both Evidence sets.",
    functionComparisonInputSchema,
  ),
  session(
    "compare_bundles",
    "Compare two canonical Evidence v2 bundles by exact record membership, explicit one-to-one observation pairs, and complete residual-unknown revision histories. Missing bundle members describe omission only, never behavioral equivalence; output is digest-anchored and deterministically paginated.",
    bundleComparisonInputSchema,
  ),
  session(
    "find_changed_behavior",
    "Aggregate validated process, artifact, and function comparison Evidence into a deterministic change report. Runtime observations remain distinct from static behavior candidates; missing or incomplete comparisons produce unresolved findings, never causal claims.",
    changedBehaviorInputSchema,
  ),
  session(
    "build_call_path",
    "Build bounded shortest-first direct-callee paths from explicit analyze_function Evidence groups using exact canonical addresses. Missing dossiers, incomplete callee pages, provider mixing, and depth frontiers remain unknown; every node and edge cites source Evidence.",
    callPathInputSchema,
  ),
  session(
    "correlate_static_and_runtime",
    "Evaluate explicit caller-declared hypotheses between exact static comparison findings and runtime comparison dimensions. Similar names or paths are never auto-matched, consistent cochange never proves causality, and unknown or truncated inputs remain unresolved.",
    staticRuntimeCorrelationInputSchema,
  ),
  session(
    "verify_reconstruction",
    "Verify a finite typed behavioral and structural specification against a canonical Evidence bundle. Pass means every declared claim has complete comparable authority—not global source equivalence; changed claims fail and missing, limited, or unresolved evidence stays unknown.",
    reconstructionVerificationInputSchema,
  ),
  session(
    "list_unknowns",
    "List current residual-unknown heads in deterministic ID order, with optional exact status, severity, and domain filters. This is read-only; unresolved, contradicted, and non-truth dispositions remain distinct.",
    z.object({
      status: z
        .enum(["open", "investigating", "blocked", "contradicted", "resolved"])
        .optional(),
      severity: z.enum(["low", "medium", "high", "critical"]).optional(),
      domain: z.string().trim().min(1).max(100).optional(),
    }),
  ),
  session(
    "record_unknown",
    "Create one deterministic residual unknown and immutable mutation evidence. Requires approved: true, validates all evidence and relationship references, and rejects duplicate stable identity.",
    recordUnknownInputSchema,
  ),
  session(
    "update_unknown",
    "Append one immutable full-state revision and mutation evidence. Requires approved: true and exact expected_revision; stale concurrent writers fail instead of overwriting newer analysis.",
    updateUnknownInputSchema,
  ),
  session(
    "verify_unknown_resolution",
    "Revalidate the current residual-unknown head against live bundled evidence, exact authority/confidence/environment requirements, and revision integrity. Withdrawn and out-of-scope dispositions are not truth claims.",
    z.object({ unknown_id: z.string().regex(/^unk_[a-f0-9]{64}$/u) }),
  ),
] as const satisfies readonly ToolContract[];

/**
 * Complete ordered public inventory used by registration and verification.
 * Keep this collection at 68 tools unless a deliberate contract change updates
 * snapshots, package verification, and real-Hopper verification together.
 */
export const TOOL_CONTRACTS = [
  ...OFFICIAL_TOOL_CONTRACTS,
  ...ENHANCED_TOOL_CONTRACTS,
  ...NATIVE_TOOL_CONTRACTS,
  ...ARTIFACT_TOOL_CONTRACTS,
  ...SESSION_TOOL_CONTRACTS,
] as const;
