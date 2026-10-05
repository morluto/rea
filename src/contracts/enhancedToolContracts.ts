import { z } from "zod";

import { enhancedInputSchemas } from "./enhancedInputs.js";
import {
  enhancedOutputSchemas,
  requireOutputSchema,
} from "./toolOutputSchemas.js";
import { examplesFor } from "./toolContractHelpers.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { FUNCTION_WORKFLOW_TOOL_CONTRACTS } from "./functionWorkflowToolContracts.js";

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
