import { z } from "zod";
import { enhancedInputSchemas } from "./enhancedInputs.js";
import {
  enhancedOutputSchemas,
  officialOutputSchemas,
  requireOutputSchema,
  sessionOutputSchemas,
} from "./toolOutputSchemas.js";
import { NATIVE_TOOL_CONTRACTS } from "./nativeToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "./artifactToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "./managedToolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "./managedWorkflowToolContracts.js";
import { BROWSER_PROVIDER_TOOL_CONTRACTS } from "./browserProviderToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "./electronToolContracts.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "./javascriptRuntimeObservationToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "./applicationToolContracts.js";
import {
  addressContextInputSchema,
  artifactComparisonInputSchema,
  binarySessionInputSchema,
  bundleComparisonInputSchema,
  callPathInputSchema,
  changedBehaviorInputSchema,
  closeBinaryInputSchema,
  functionComparisonInputSchema,
  importEvidenceBundleInputSchema,
  listUnknownsInputSchema,
  navigationContextInputSchema,
  openBinaryInputSchema,
  processComparisonInputSchema,
  processScenarioSchema,
  reconstructionVerificationInputSchema,
  recordUnknownInputSchema,
  replayMachineRunInputSchema,
  getEvidenceBundleInputSchema,
  staticRuntimeCorrelationInputSchema,
  updateUnknownInputSchema,
  verifyUnknownResolutionInputSchema,
} from "./sessionToolSchemas.js";
import {
  address,
  document,
  examplesFor,
  optionalAddress,
  procedure,
} from "./toolContractHelpers.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { nativeDataTypeInputSchema } from "../domain/nativeDataType.js";
import { nativeInstructionInputSchema } from "../domain/nativeInstruction.js";
import { functionInstructionInputSchema } from "./functionInstructionContract.js";
import { HOPPER_MEMORY_TOOL_DEFINITIONS } from "./hopperMemoryContracts.js";
import { analysisSearchInput } from "./analysisSearchContract.js";
import { FUNCTION_WORKFLOW_TOOL_CONTRACTS } from "./functionWorkflowToolContracts.js";

export {
  addressContextInputSchema,
  binarySessionInputSchema,
  importEvidenceBundleInputSchema,
  listUnknownsInputSchema,
  navigationContextInputSchema,
  processComparisonInputSchema,
  getEvidenceBundleInputSchema,
  verifyUnknownResolutionInputSchema,
} from "./sessionToolSchemas.js";

export type { ToolContract, ToolExample } from "./toolContractTypes.js";

const official = <Name extends string, Schema extends z.ZodObject>(
  name: Name,
  description: string,
  inputSchema: Schema,
) =>
  ({
    name,
    ...toolContractMetadata(name),
    description,
    kind: "official-proxy",
    inputSchema,
    outputSchema: requireOutputSchema(officialOutputSchemas, name),
    examples: examplesFor(name, inputSchema),
  }) satisfies ToolContract<Name, Schema>;

const enhanced = <Name extends string, Schema extends z.ZodObject>(
  name: Name,
  description: string,
  inputSchema: Schema,
) =>
  ({
    name,
    ...toolContractMetadata(name),
    description,
    kind: "enhanced",
    inputSchema,
    outputSchema: requireOutputSchema(enhancedOutputSchemas, name),
    examples: examplesFor(name, inputSchema),
  }) satisfies ToolContract<Name, Schema>;

const session = <Name extends string, Schema extends z.ZodObject>(
  name: Name,
  description: string,
  inputSchema: Schema,
) =>
  ({
    name,
    ...toolContractMetadata(name),
    description,
    kind: "session",
    inputSchema,
    outputSchema: requireOutputSchema(sessionOutputSchemas, name),
    examples: examplesFor(name, inputSchema),
  }) satisfies ToolContract<Name, Schema>;

/** Bridge operations exposed without additional application composition. */
export const OFFICIAL_TOOL_CONTRACTS = [
  official(
    "inspect_native_data_type",
    "Inspect one recovered type by exact database category path or defined typed data address. Returns observed size, alignment, packing, fields, bitfields, enum values, and child type identities; source-level authority and flexible-tail semantics remain unknown unless substantiated.",
    nativeDataTypeInputSchema,
  ),
  official(
    "inspect_native_instruction",
    "Inspect one exact instruction address: decoded bytes, mnemonic, ordered operand tokens, flow and typed references. Memory addressing decomposition is unavailable when the provider supplies only tokens. Data, interior instruction addresses and undecodable bytes are distinct outcomes.",
    nativeInstructionInputSchema,
  ),
  official(
    "resolve_native_call_targets",
    "Resolve one explicit static call site using typed provider call references. Preserves ambiguous targets as candidates and unresolved computed calls as unknown; does not execute code or traverse a call graph.",
    nativeInstructionInputSchema,
  ),
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
    "Return the analyzed procedure containing Hopper's current cursor. This uses GUI cursor state and is not a procedure-name lookup.",
    z.object({ document }),
  ),
  official(
    "current_document",
    "Return the document currently selected by REA's Hopper bridge.",
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
    "List every analyzed memory and external symbol as address/value pairs. Provider metadata distinguishes Ghidra primary, dynamic, external, type, and source facts when available.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "list_procedures",
    "List every analyzed procedure as address/value pairs after provider analysis. Ghidra metadata distinguishes thunks and external functions; use returned addresses in later function operations.",
    z.object({ document }),
  ),
  official(
    "list_segments",
    "List segments or memory blocks using exclusive end addresses. Ghidra reports block permissions, address space, image base, initialization, and overlay facts; Hopper marks unavailable permissions explicitly.",
    z.object({ document }),
  ),
  official(
    "list_strings",
    "List every provider-defined string, or filter to one address, as address/value pairs. Ghidra also reports encoding, terminator status, and byte length.",
    z.object({ document, address: optionalAddress }),
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
    "Resolve an unambiguous procedure symbol name or provider-normalized address to its canonical entry address. External address spaces remain explicit.",
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
    "Return provider metadata for one procedure identified by symbol or address: entrypoint, signature, locals, size, and block count.",
    z.object({ procedure, document }),
  ),
  official(
    "read_function_instructions",
    "Return every raw instruction for one analyzed procedure. Instruction text is provider-specific.",
    functionInstructionInputSchema,
  ),
  ...HOPPER_MEMORY_TOOL_DEFINITIONS.map(({ name, description, inputSchema }) =>
    official(name, description, inputSchema),
  ),
  official(
    "procedure_references",
    "Return every raw incoming or outgoing reference edge for one procedure. Endpoint procedures are resolved only from provider containment; Ghidra preserves observed reference kinds while providers without kind authority mark them unavailable.",
    z.object({
      procedure,
      direction: z.enum(["incoming", "outgoing"]).default("outgoing"),
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
    "Search every analyzed procedure name using literal matching by default or regex when requested. Results are deterministic and complete.",
    z.object(analysisSearchInput),
  ),
  official(
    "search_strings",
    "Search every analyzed string using literal matching by default or regex when requested. Results are deterministic and complete.",
    z.object(analysisSearchInput),
  ),
  official(
    "set_address_name",
    "Assign an analyst name to one hexadecimal address and report Hopper's boolean result. This mutates analysis metadata.",
    z.object({ address, name: z.string(), document }),
  ),
  official(
    "set_addresses_names",
    "Assign analyst names to multiple addresses in one call and return per-address success booleans. This mutates analysis metadata; verify failures individually.",
    z.object({ names: z.record(z.string(), z.string()), document }),
  ),
  official(
    "set_bookmark",
    "Create or replace a bookmark at a hexadecimal address and report success. This mutates navigation metadata; bookmarks are analyst-authored navigation aids, not binary evidence.",
    z.object({ address, name: z.string().optional(), document }),
  ),
  official(
    "set_comment",
    "Write a regular analysis comment at a hexadecimal address and return whether readback matched. This mutates the Hopper document; use comments to record evidence IDs or reasoning.",
    z.object({ address, comment: z.string(), document }),
  ),
  official(
    "set_current_document",
    "Select an already-open Hopper document by exact document name. This changes subsequent default-document routing; list_documents can supply names when needed, while explicit document inputs keep calls reproducible.",
    z.object({ document: z.string() }),
  ),
  official(
    "set_inline_comment",
    "Write an inline instruction comment at a hexadecimal address and return whether readback matched. This mutates analysis metadata.",
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

/** Workflow tools composed from one or more provider operations. */
export const ENHANCED_TOOL_CONTRACTS = [
  enhanced(
    "inspect_native_dispatch_metadata",
    "Inspect the bound provider's name inventory for Objective-C class/method symbols and Swift mangled symbols, returning at most max_records decoded names. Includes target SHA-256 when available, provider identity/version, analysis-profile digest, facet coverage, and per-record Evidence. This is symbol-level evidence, not runtime metadata: ivar layouts, protocol conformances, witness/class tables, and relative pointers are explicitly marked unsupported unless a provider supplies those decoders. The provider controls how its name inventory is acquired.",
    enhancedInputSchemas.inspect_native_dispatch_metadata,
  ),
  enhanced(
    "get_objc_classes",
    "Discover and deduplicate Objective-C class labels, optionally filtering by literal substring.",
    enhancedInputSchemas.get_objc_classes,
  ),
  enhanced(
    "get_objc_protocols",
    "Discover and deduplicate Objective-C and Swift protocol labels.",
    enhancedInputSchemas.get_objc_protocols,
  ),
  enhanced(
    "batch_decompile",
    "Decompile each explicit procedure symbol or address concurrently. Returns ordered per-item success or error results and aggregate counts.",
    enhancedInputSchemas.batch_decompile,
  ),
  enhanced(
    "get_call_graph",
    "Traverse the bound provider's caller or callee relationships from one symbol or address until the reachable graph is exhausted. Every node has an ok/error status and failures use safe typed projections; unresolved indirect calls may be missing and results are not a whole-program CFG.",
    enhancedInputSchemas.get_call_graph,
  ),
  enhanced(
    "analyze_swift_types",
    'Categorize analyzed procedure names into Swift classes, structs, enums, protocols, extensions, and other symbols. Returns deduplicated names grouped with counts. Optionally select one category and/or apply a case-sensitive literal name filter; for example, use {category: "classes", pattern: "Account"} to find matching class symbols.',
    enhancedInputSchemas.analyze_swift_types,
  ),
  enhanced(
    "find_xrefs_to_name",
    "Resolve an exact name against the bound provider's name inventory and return a resolved or unresolved result. Unresolved names use the stable name_not_found reason; this xref workflow returns address-only projections.",
    enhancedInputSchemas.find_xrefs_to_name,
  ),
  enhanced(
    "binary_overview",
    "Return native-binary metadata, every segment with its length, and exhaustive procedure/string counts. Use search_procedures, list_procedures, or analyze_function directly when you already know which procedure to inspect.",
    enhancedInputSchemas.binary_overview,
  ),
  ...FUNCTION_WORKFLOW_TOOL_CONTRACTS,
  enhanced(
    "trace_feature",
    "Trace a literal feature query through every matching string and procedure, their xrefs, and truthful containing-procedure resolution. Returns observations, operation count, and residual unknowns without inferring reference kinds.",
    enhancedInputSchemas.trace_feature,
  ),
  enhanced(
    "find_code_for_string",
    "Resolve one literal string query across analyzed string entries, xrefs, and truthful containing-procedure candidates. Returns observations, operation count, and residual unknowns; it never infers reference kinds or runtime reachability.",
    enhancedInputSchemas.find_code_for_string,
  ),
  enhanced(
    "trace_call_path",
    "Trace direct callers or callees from one exact procedure address until the graph is exhausted or the optional goal is reached. Returns visited nodes, direct-call edges, a shortest traversal path, provider failures, and residual unknowns; unresolved indirect calls remain unknown.",
    enhancedInputSchemas.trace_call_path,
  ),
  enhanced(
    "trace_native_ui_action",
    "Trace one unique compiled UI action, object ID, native symbol or exact function address through authored connections, encoded or symbolized Objective-C handlers, and bounded static call references. Typed direct and resolved indirect calls, ambiguous candidates, inferred untyped provider callees, and targetless sites remain distinct. Runtime reachability is unknown; use trace_native_values for recovered value dependencies.",
    enhancedInputSchemas.trace_native_ui_action,
  ),
  enhanced(
    "trace_native_values",
    "Trace a bounded static dependency graph from one explicit native procedure. Includes high-p-code def-use, constants, operators, memory and branch operations, resolved call edges, and derived argument/parameter and return/output bindings. Missing bindings, alias semantics, persistent state and RNG roles remain unknown. Budgets bound depth, decompilations, graph size and payloads; nodes are paginated.",
    enhancedInputSchemas.trace_native_values,
  ),
] as const satisfies readonly ToolContract[];

/** Session-owned Evidence bundle export options. */
export const exportEvidenceBundleInputSchema = z.strictObject({
  path: z.string().min(1),
  overwrite: z.boolean().default(false),
});

/** Target lifecycle tools available only on the long-lived MCP adapter. */
export const SESSION_TOOL_CONTRACTS = [
  session(
    "open_binary",
    "Open a local executable, application bundle, archive, JavaScript, source map, plist, or analysis database after validation. provider_id selects one deep provider or deterministic auto selection; the binding remains stable until close or an explicit switch, with no failure fallback. An optional analysis snapshot is imported atomically and must match the binary identity, concrete provider, and canonical analysis profile exactly.",
    openBinaryInputSchema,
  ),
  session(
    "close_binary",
    "Optionally write a provider-neutral analysis snapshot atomically to the caller-supplied path, then close the active target and every provider resource started for it. Existing files require explicit overwrite; a failed save leaves the session open so cached analysis is not lost.",
    closeBinaryInputSchema,
  ),
  session(
    "binary_session",
    "Report the complete current target, provider, capability availability, client-feature, analysis, and server-identity status without starting analysis.",
    binarySessionInputSchema,
  ),
  session(
    "export_evidence_bundle",
    "Atomically write the session's deterministic Evidence bundle to the requested local path. Existing files require overwrite: true; records and manifests use canonical byte-stable ordering.",
    exportEvidenceBundleInputSchema,
  ),
  session(
    "import_evidence_bundle",
    "Read the JSON bundle at the supplied local path, validate every Evidence ID and canonical manifest, then atomically merge it. Imported content is data only and is never executed.",
    importEvidenceBundleInputSchema,
  ),
  session(
    "capture_process_scenario",
    "Run one bounded process under a PTY using operator-approved executable and working roots. Produces process capture Evidence and records residual unknowns linked to that Evidence. Captures raw and xterm-rendered terminal frames, scripted interactions, lifecycle filesystem checkpoints, process ownership, declarative command shims, and loopback replay. Disabled unless operator policy enables it; not a security sandbox.",
    processScenarioSchema,
  ),
  session(
    "compare_process_captures",
    "Compare two compatible process capture observations across terminal, interaction, lifecycle, process, filesystem, command-shim, HTTP, and WebSocket evidence. Optional trace_spec validates exact events against an explicit partial order or finite trace language; concurrency is never inferred from timestamps or broad sorting. Missing, journal-free, or truncated observations are never treated as equivalent.",
    processComparisonInputSchema,
  ),
  session(
    "compare_artifacts",
    "Compare complete artifact inventories by logical occurrence path, content identity, metadata, and graph relations. Pass the inventory Evidence nested in each inspect_artifact result as left and right. Every delta cites both inputs, and gaps yield truncated or unknown, never equivalence. Returns every change inline.",
    artifactComparisonInputSchema,
  ),
  session(
    "compare_functions",
    "Compare two explicit sets of analyze_function Evidence across identity, exact provider text, calls, references, strings, and address-normalized CFG topology. Missing or provider-incompatible facets remain truncated or unknown; every conclusion cites both Evidence sets.",
    functionComparisonInputSchema,
  ),
  session(
    "compare_bundles",
    "Compare two canonical Evidence bundles by exact record membership, explicit one-to-one observation pairs, and complete residual-unknown revision histories. Missing bundle members describe omission only, never behavioral equivalence; output is digest-anchored and returns every change inline.",
    bundleComparisonInputSchema,
  ),
  session(
    "find_changed_behavior",
    "Aggregate validated process and artifact comparison Evidence. Runtime observations remain distinct from static behavior candidates; missing or incomplete comparisons produce unresolved findings, never causal claims. Returns every finding inline.",
    changedBehaviorInputSchema,
  ),
  session(
    "build_call_path",
    "Build every shortest direct-callee path inline from complete analyze_function Evidence records using exact canonical addresses. Missing dossiers and provider mixing remain unknown; every node and edge cites source Evidence.",
    callPathInputSchema,
  ),
  session(
    "correlate_static_and_runtime",
    "Evaluate every explicit caller-declared hypothesis between exact static comparison findings and runtime comparison dimensions. Similar names or paths are never auto-matched, consistent cochange never proves causality, and unknown or truncated inputs remain unresolved. Returns all correlations and their complete Evidence closure inline.",
    staticRuntimeCorrelationInputSchema,
  ),
  session(
    "verify_reconstruction",
    "Verify a finite typed behavioral and structural specification against a canonical Evidence bundle. Pass means every declared claim has complete comparable authority—not global source equivalence; changed claims fail and missing, limited, or unresolved evidence stays unknown.",
    reconstructionVerificationInputSchema,
  ),
  session(
    "list_unknowns",
    "List every current residual-unknown head in deterministic ID order, with optional exact status, severity, and domain filters. Results are complete and inline. This is read-only; unresolved, contradicted, and non-truth dispositions remain distinct.",
    listUnknownsInputSchema,
  ),
  session(
    "record_unknown",
    "Create one deterministic residual unknown and immutable mutation evidence. Validates all evidence and relationship references, and rejects duplicate stable identity.",
    recordUnknownInputSchema,
  ),
  session(
    "update_unknown",
    "Append one immutable full-state revision and mutation evidence. Requires exact expected_revision; stale concurrent writers fail instead of overwriting newer analysis.",
    updateUnknownInputSchema,
  ),
  session(
    "verify_unknown_resolution",
    "Revalidate the current residual-unknown head against live bundled evidence, exact authority/confidence/environment requirements, and revision integrity. Withdrawn and out-of-scope dispositions are not truth claims.",
    verifyUnknownResolutionInputSchema,
  ),
  session(
    "run_replay_machine",
    "Evaluate ordered HTTP and WebSocket events directly against one validated finite replay machine without opening sockets or launching a target. Returns every decision, a capture-value-free transition journal, one redacted action table entry per used transition, captured aliases, final state, and exact configured and consumed limits.",
    replayMachineRunInputSchema,
  ),
  session(
    "get_evidence_bundle",
    "Return every Evidence record and residual unknown currently retained by this session as one inline bundle for direct inspection or follow-up workflows.",
    getEvidenceBundleInputSchema,
  ),
  session(
    "get_navigation_context",
    "Return the selected document, current address, and containing/current procedure in one provider-neutral result. The result reflects sequential provider observations, not an atomic cursor snapshot; a cursor outside any procedure returns procedure: null.",
    navigationContextInputSchema,
  ),
  session(
    "inspect_address_context",
    "Inspect one explicit reproducible address for its analyzed name, containing procedure, regular and inline comments, and matching bookmarks. Each unsupported facet returns a typed unavailable outcome; use xrefs, assembly, or pseudocode for those deeper views.",
    addressContextInputSchema,
  ),
] as const satisfies readonly ToolContract[];

/** Complete ordered public inventory used by registration and verification. */
export const TOOL_CONTRACTS = [
  ...OFFICIAL_TOOL_CONTRACTS,
  ...ENHANCED_TOOL_CONTRACTS,
  ...NATIVE_TOOL_CONTRACTS,
  ...ARTIFACT_TOOL_CONTRACTS,
  ...MANAGED_TOOL_CONTRACTS,
  ...MANAGED_WORKFLOW_TOOL_CONTRACTS,
  ...BROWSER_PROVIDER_TOOL_CONTRACTS,
  ...ELECTRON_TOOL_CONTRACTS,
  ...JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS,
  ...APPLICATION_TOOL_CONTRACTS,
  ...SESSION_TOOL_CONTRACTS,
] as const;
