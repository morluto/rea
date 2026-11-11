import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";
import { analysisDetailSchema } from "./analysisDetail.js";
import { z } from "zod";

import { enhancedInputSchemas } from "./enhancedInputs.js";
import { enhancedOutputSchemas } from "./toolOutputSchemaGroups.js";
import { examplesFor } from "./toolContractHelpers.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { FUNCTION_WORKFLOW_TOOL_CONTRACTS } from "./functionWorkflowToolContracts.js";

const enhanced = <
  Name extends keyof typeof enhancedOutputSchemas,
  Schema extends z.ZodObject,
>(
  name: Name,
  description: string,
  inputSchema: Schema,
) =>
  ({
    name,
    ...toolContractMetadata(name),
    description,
    kind: "enhanced",
    requiresActiveTarget: true,
    inputSchema,
    outputSchema: requireOutputSchema(enhancedOutputSchemas, name),
    examples: examplesFor(name, inputSchema),
  }) satisfies ToolContract<Name, Schema>;

/** Workflow tools composed from one or more provider operations. */
export const ENHANCED_TOOL_CONTRACTS = [
  enhanced(
    "inspect_native_dispatch_metadata",
    "Inspect analyzed Objective-C class/method and Swift mangled symbols, with optional exact Objective-C import-pointer binding facts from the selected Mach-O slice. Returns decoded names up to max_records, provider/profile identity, target digest when available, facet coverage and per-record Evidence. Symbol observations do not establish runtime layouts, conformances or witness/class tables. The selected provider owns name discovery. max_input_bytes bounds the whole-file Mach-O read; unresolved bindings remain partial or unsupported.",
    enhancedInputSchemas.inspect_native_dispatch_metadata,
  ),
  enhanced(
    "get_objc_classes",
    "Find Objective-C class labels, optionally by literal substring. Labels remain separate unless exact selected-image pointer-fixup Evidence establishes the same imported class binding, including library, ordinal, weak status and addend. Missing binding proof remains unknown, partial or unsupported.",
    enhancedInputSchemas.get_objc_classes,
  ),
  enhanced(
    "get_objc_protocols",
    "Discover and deduplicate Objective-C and Swift protocol labels.",
    enhancedInputSchemas.get_objc_protocols,
  ),
  enhanced(
    "batch_decompile",
    "Decompile an explicit list of procedure symbols/addresses in input order, with one provider read active per batch. Returns per-item pseudocode, unavailable or error outcomes and aggregate counts; input selectors and observed canonical procedure identities remain separate. Null pseudocode is unavailable, without an inferred capability or retry reason; failed counts include unavailable items. detail summary retains the batch for inspect_analysis_view item/body pages; complete includes every body. Per-function limits do not bound the whole batch.",
    enhancedInputSchemas.batch_decompile.extend({
      detail: analysisDetailSchema,
    }),
  ),
  enhanced(
    "decompile_all",
    "Export pseudocode for all or selected analyzed functions to a directory; returns a manifest/index, with bodies kept in files. Existing output requires resume with matching target, provider, profile and layout; verified files are skipped and conflicts preserved. External functions produce no file. Item failures do not stop others; cancellation keeps written files. retry_failed: independent_fresh retries only provider-reported function failures when supported, retaining each attempt and its limitations; independent attempts may use different analysis context. layout dwarf falls back to address filenames when compilation-unit paths are unavailable. Select limit/resume to fit the whole client deadline; per-function limits do not bound the export.",
    enhancedInputSchemas.decompile_all,
  ),
  enhanced(
    "get_call_graph",
    "Traverse the provider-observed caller or callee graph from one symbol/address, returning canonical-address nodes with per-node outcomes. Use trace_call_path for a shortest path to a goal, or build_call_path to compose existing function dossiers without provider reads. Indirect calls may be unresolved; this is not a whole-program CFG. detail summary retains the complete graph for native-observation pages and native-context caveats.",
    enhancedInputSchemas.get_call_graph.extend({
      detail: analysisDetailSchema,
    }),
  ),
  enhanced(
    "analyze_swift_types",
    'Classify analyzed Swift procedure names into classes, structs, enums, protocols and extensions using manglings or same-address symbol aliases. Returns deduplicated procedure-name counts, not unique source types; provider names, mangled_names and unresolved classifications remain available. Category and case-sensitive literal pattern filters do not suppress unclassified rows. Example: {category: "structs", pattern: "Pair"}.',
    enhancedInputSchemas.analyze_swift_types,
  ),
  enhanced(
    "find_xrefs_to_name",
    "Find references to an exact analyzed symbol name: resolves the name, then returns its address and referencing addresses. name_not_found means lookup is unresolved, not that a reference search found none or the target lacks the symbol. References are address-only; use inspect_native_instruction for typed incoming references where supported. Kuna lacks the required general name inventory; xrefs can resolve names its inventory knows.",
    enhancedInputSchemas.find_xrefs_to_name,
  ),
  enhanced(
    "binary_overview",
    "Summarize the bound document, complete provider-inventory procedure/string row counts, and segments when supported. Counts do not establish discovery of every function/string and are not comparable across providers. Omitted segments mean unavailable coverage. image_base is returned only when observed segments agree. Use search_procedures, list_procedures or analyze_function directly when the procedure is already known.",
    enhancedInputSchemas.binary_overview,
  ),
  ...FUNCTION_WORKFLOW_TOOL_CONTRACTS,
  enhanced(
    "trace_feature",
    "Search procedure/string inventories for the complete literal query, then query xrefs at matched start addresses. Interior-byte references are not searched; empty results or truncated: false never establish no references. Containment refusals preserve an unavailable owner, and reference kinds remain unknown. For typed incoming procedure references use procedure_references, comparing target addresses for exact-entry matches. detail summary retains matches/references/unknowns for inspect_analysis_view kind native-feature-trace.",
    enhancedInputSchemas.trace_feature.extend({ detail: analysisDetailSchema }),
  ),
  enhanced(
    "trace_call_path",
    "Resolve start and optional goal symbols or addresses, then trace direct callers or callees. Returns observed edges and a shortest path within the provider-observed graph. search_scope distinguishes the observed-graph result from whether discovery is established; a missing goal is unknown when relationship reads or discovery are incomplete. Unresolved indirect calls remain unknown.",
    enhancedInputSchemas.trace_call_path,
  ),
  enhanced(
    "trace_native_ui_action",
    "Trace one unique compiled UI action, object ID, native symbol or exact function address through authored connections, encoded or symbolized Objective-C handlers, and bounded static call references. Typed direct and resolved indirect calls, ambiguous candidates, inferred untyped provider callees, and targetless sites remain distinct. Runtime reachability is unknown; use trace_native_values for recovered value dependencies.",
    enhancedInputSchemas.trace_native_ui_action,
  ),
  enhanced(
    "trace_native_values",
    "Trace static value dependencies across resolved calls from one native procedure: high-p-code def-use, constants, operators, memory/branch operations and derived argument/return bindings. Alias effects, missing bindings, persistent state and RNG roles remain unknown. Caller-selected budgets bound traversal and retained facts; nodes are paged. A Ghidra per-function timeout does not bound the traversal: allow startup and every attempted function, or reduce max_functions.",
    enhancedInputSchemas.trace_native_values,
  ),
] as const satisfies readonly ToolContract[];
