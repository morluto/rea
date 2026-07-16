import { z } from "zod";
import { jsonValueSchema } from "../domain/jsonValue.js";
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
import { BROWSER_TOOL_CONTRACTS } from "./browserToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "./electronToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "./applicationToolContracts.js";
import {
  closeBinaryInputSchema,
  openBinaryInputSchema,
} from "./sessionLifecycleInputs.js";
import type {
  ToolAnnotations,
  ToolContract,
  ToolExample,
  ToolKind,
} from "./toolContractTypes.js";

export type {
  ToolAnnotations,
  ToolContract,
  ToolExample,
} from "./toolContractTypes.js";

const document = z.string().optional().describe("The document name");
const address = z
  .string()
  .describe(
    "A provider-normalized address; default memory uses 0x-prefixed hexadecimal",
  );
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
    name === "close_binary" ||
    name === "unset_bookmark" ||
    name === "set_address_name" ||
    name === "set_addresses_names" ||
    name === "set_comment" ||
    name === "set_inline_comment",
  idempotentHint:
    name !== "close_binary" &&
    name !== "record_unknown" &&
    name !== "update_unknown",
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
    "Resolve the primary analyzed name at a code or data address. Headless providers require an explicit address; GUI providers may default to their current cursor. Null means the provider has no primary name at that address.",
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
    "List provider program or document identities. Hopper may expose several documents; a Ghidra headless session contains exactly its one imported Program.",
    z.object({}),
  ),
  official(
    "list_names",
    "Page through analyzed memory and external symbols as address/value pairs. Provider metadata distinguishes Ghidra primary, dynamic, external, type, and source facts when available; follow next_offset before claiming exhaustive coverage.",
    z.object({ document, address: optionalAddress, ...pagination }),
  ),
  official(
    "list_procedures",
    "Page through analyzed procedures as address/value pairs after provider analysis. Ghidra metadata distinguishes thunks and external functions; follow next_offset for exhaustive coverage and use returned addresses in later function operations.",
    z.object({ document, ...pagination }),
  ),
  official(
    "list_segments",
    "List segments or memory blocks using exclusive end addresses. Ghidra reports block permissions, address space, image base, initialization, and overlay facts; Hopper marks unavailable permissions explicitly.",
    z.object({ document }),
  ),
  official(
    "list_strings",
    "Page through provider-defined strings, or filter to one address, as address/value pairs. Ghidra reports charset, missing-terminator status, byte length, and explicit value truncation; follow next_offset for exhaustive results.",
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
    "Resolve an unambiguous procedure symbol name or provider-normalized address to its canonical entry address. External address spaces remain explicit; use the result before xrefs, assembly, or decompilation.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_assembly",
    "Return assembly for one analyzed procedure identified by symbol or hexadecimal address. Use when pseudocode loses calling-convention or instruction-level detail; output is currently returned as one unpaginated string.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_callees",
    "Return the provider's resolved direct callees for one procedure identified by symbol or address. Unresolved indirect calls may be absent; use analyze_function and typed references to preserve available edge uncertainty.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_callers",
    "Return the provider's resolved direct callers for one procedure identified by symbol or address. Results reflect completed static analysis and may omit unresolved indirect references.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_info",
    "Return bounded metadata for one procedure identified by symbol or address: entrypoint, signature, locals, size, and block count. Follow with decompilation or assembly for behavior.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_references",
    "Return a bounded set of raw incoming or outgoing reference edges for one procedure. Endpoint procedures are resolved only from provider containment; Ghidra preserves observed reference kinds while providers without kind authority mark them unavailable.",
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
    "Decompile one analyzed procedure by symbol name or provider-normalized address. Returns provider-specific pseudocode, never original source or cross-provider text equivalence, and may return null; request procedure_assembly when instruction precision matters.",
    z.object({ procedure, document }),
  ),
  official(
    "resolve_containing_procedure",
    "Resolve an arbitrary address, including an interior instruction or exact external entry, to its provider-analyzed containing procedure. A negative result distinguishes outside segments from not in a procedure and is never guessed from nearby symbols.",
    z.object({ address, document }),
  ),
  official(
    "search_procedures",
    "Search analyzed procedure names using literal matching by default or regex opt-in. Ghidra bounds literal work and rejects regex constructs, paths, candidates, or cumulative work outside its finite budgets. Results are deterministic and offset-paginated.",
    z.object(searchInput),
  ),
  official(
    "search_strings",
    "Search analyzed strings using literal matching by default or regex opt-in. Ghidra bounds literal work and rejects regex constructs, paths, candidates, or cumulative work outside its finite budgets. Results are deterministic, offset-paginated, and explicitly truncated.",
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
    "Decompile up to 20 explicit procedure symbols or addresses concurrently. Returns ordered per-item ok/error variants and aggregate counts; use analyze_function for a richer single-function dossier.",
    enhancedInputSchemas.batch_decompile,
  ),
  enhanced(
    "get_call_graph",
    "Traverse the bound provider's caller or callee relationships from one symbol or address for at most five levels. Every node has an ok/error status and failures use safe typed projections; unresolved indirect calls may be missing and results are not a whole-program CFG.",
    enhancedInputSchemas.get_call_graph,
  ),
  enhanced(
    "analyze_swift_types",
    "Categorize exhaustively paged procedure names into Swift classes, structs, enums, protocols, extensions, and other symbols. Scans at most 5,000 names and returns at most 50 entries per category.",
    enhancedInputSchemas.analyze_swift_types,
  ),
  enhanced(
    "find_xrefs_to_name",
    "Resolve an exact name through the bound provider's exhaustively paged name inventory and return a resolved or unresolved result. Unresolved names use the stable name_not_found reason; this compact xref workflow returns address-only projections.",
    enhancedInputSchemas.find_xrefs_to_name,
  ),
  enhanced(
    "binary_overview",
    "Use immediately after opening a target to summarize document, exhaustive procedure/string counts, and a bounded segment sample. detail controls segment fields and limit controls only the returned segment sample.",
    enhancedInputSchemas.binary_overview,
  ),
  enhanced(
    "analyze_function",
    "Preferred bounded analysis for one procedure symbol or address. Returns identity, provider-specific pseudocode, optional assembly, comments, calls, typed-or-explicitly-unavailable references, referenced strings/names, and local CFG blocks with exact truncation metadata.",
    enhancedInputSchemas.analyze_function,
  ),
  enhanced(
    "trace_feature",
    "Trace a bounded literal feature query through matching strings and procedures, xrefs, and truthful containing-procedure resolution. Returns the operation budget, truncation, and residual unknowns; unknown_registry_approved: true records them durably without inferring reference kinds.",
    enhancedInputSchemas.trace_feature,
  ),
] as const satisfies readonly ToolContract[];

/** Caller observations used to compare a live server with expected identity. */
export const binarySessionInputSchema = z.object({
  expected_package_version: z.string().min(1).optional(),
  expected_catalog_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  expected_server_path: z.string().min(1).optional(),
});

/** Target lifecycle tools available only on the long-lived MCP adapter. */
export const SESSION_TOOL_CONTRACTS = [
  session(
    "open_binary",
    "Open a local executable, application bundle, archive, JavaScript, source map, plist, or analysis database after validation. provider_id selects one deep provider or deterministic auto selection; the binding remains stable until close or an explicit switch, with no failure fallback. An optional snapshot v2 is imported atomically and must match the binary identity, concrete provider, and canonical analysis profile exactly.",
    openBinaryInputSchema,
  ),
  session(
    "close_binary",
    "Optionally write a provider-neutral analysis snapshot atomically, then close the active target and every provider resource started for it. Snapshot files require an operator-approved root and explicit overwrite; a failed save leaves the session open so cached analysis is not lost.",
    closeBinaryInputSchema,
  ),
  session(
    "binary_session",
    "Report deterministic deep-provider candidates, host availability, target support, the immutable active binding/profile, capability descriptors, and whether a target is open. Candidate discovery never starts an analysis process; use rejection codes and local diagnostics before choosing provider_id.",
    binarySessionInputSchema,
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
    "Run one bounded process under a PTY using operator-approved executable and working roots. Produces Process Capture v4; legacy v3 captures cannot be upgraded and must be recaptured with this tool. Requires approved: true; unknown_registry_approved: true separately records capture residuals. Captures raw and xterm-rendered terminal frames, scripted interactions, lifecycle filesystem checkpoints, process ownership, declarative command shims, and loopback replay. Disabled unless operator policy enables it; not a security sandbox.",
    processScenarioSchema,
  ),
  session(
    "compare_process_captures",
    "Compare two compatible Process Capture v4 observations across terminal, interaction, exit, settlement, process, filesystem, command-shim, HTTP, and WebSocket evidence, returning the first bounded divergence. Process Capture v3 is unsupported and must be recaptured with capture_process_scenario. Missing or truncated observations are never treated as equivalent.",
    z.object({
      left_evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
      left: processCaptureSchema,
      right_evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
      right: processCaptureSchema,
      max_capture_age_ms: z.number().int().nonnegative().optional(),
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
    "Aggregate validated comparison Evidence, or automatically run and resume a persistent cross-version artifact investigation beneath an approved evidence root. Runtime observations remain distinct from static behavior candidates; missing or incomplete comparisons produce unresolved findings, never causal claims.",
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

/** Complete ordered public inventory used by registration and verification. */
export const TOOL_CONTRACTS = [
  ...OFFICIAL_TOOL_CONTRACTS,
  ...ENHANCED_TOOL_CONTRACTS,
  ...NATIVE_TOOL_CONTRACTS,
  ...ARTIFACT_TOOL_CONTRACTS,
  ...BROWSER_TOOL_CONTRACTS,
  ...ELECTRON_TOOL_CONTRACTS,
  ...APPLICATION_TOOL_CONTRACTS,
  ...SESSION_TOOL_CONTRACTS,
] as const;
