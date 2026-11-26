import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { analysisDetailSummaryDefaultSchema } from "./analysisDetail.js";
import { enhancedInputSchemas } from "./enhancedInputs.js";
import { TOOL_EXAMPLE_OVERRIDES } from "./toolContractExamples.js";
import type { ToolContract } from "./toolContractTypes.js";
import type { EffectAudit } from "./toolEffects.js";
import {
  toolContractMetadata,
  providerEffects,
  providerNetworkEvidenceEffects,
  providerRemoteEffects,
  providerUiNetworkEvidenceEffects,
  toolEffects,
} from "./toolEffects.js";
import { enhancedOutputSchemas } from "./toolOutputSchemaGroups.js";

type FunctionWorkflowName =
  | "analyze_function"
  | "inspect_native_api"
  | "reconstruct_procedure_hardware_interactions";

/**
 * MCP inputs: the provider input plus analyze_function's delivery detail, which
 * the tool handler separates before any provider call. Composed workflows such
 * as inspect_native_api build provider inputs from enhancedInputSchemas alone.
 */
export const functionWorkflowInputSchemas = {
  analyze_function: enhancedInputSchemas.analyze_function.extend({
    detail: analysisDetailSummaryDefaultSchema,
  }),
  inspect_native_api: enhancedInputSchemas.inspect_native_api,
  reconstruct_procedure_hardware_interactions:
    enhancedInputSchemas.reconstruct_procedure_hardware_interactions,
} as const;

/** The contracts below that the CLI exposes as commands. */
const FUNCTION_WORKFLOW_CLI_CONTRACTS: ReadonlySet<string> = new Set([
  "inspect_native_api",
  "reconstruct_procedure_hardware_interactions",
]);

const functionWorkflow = <Name extends FunctionWorkflowName>(
  name: Name,
  audit: EffectAudit,
  description: string,
) => {
  const inputSchema = functionWorkflowInputSchemas[name];
  const outputSchema = requireOutputSchema(enhancedOutputSchemas, name);
  return {
    name,
    ...toolContractMetadata(name, audit),
    description,
    kind: "enhanced",
    ...(FUNCTION_WORKFLOW_CLI_CONTRACTS.has(name)
      ? { cli: true as const }
      : {}),
    requiresActiveTarget: true,
    inputSchema,
    outputSchema,
    examples: [
      {
        title: `Example ${name.replaceAll("_", " ")} request`,
        input: jsonObjectSchema.parse(
          inputSchema.parse(TOOL_EXAMPLE_OVERRIDES[name] ?? {}),
        ),
      },
    ],
  } satisfies ToolContract<Name, typeof inputSchema, typeof outputSchema>;
};

/** Function dossier and native API reconstruction workflow contracts. */
export const FUNCTION_WORKFLOW_TOOL_CONTRACTS = [
  functionWorkflow(
    "analyze_function",
    providerUiNetworkEvidenceEffects,
    "Inspect one native function by symbol or provider-returned address. Default summary returns identity, pseudocode size, facet counts and value-flow availability while retaining the complete dossier. Read selected facts with inspect_analysis_view using normalized_result.parent_evidence_id; detail complete returns everything inline. Facets include pseudocode, assembly, body ranges, comments, calls, references, strings/names, CFG and native API observations. Extents reflect provider analysis; limitations report unknown ranges and possible Ghidra terminal-call truncation.",
  ),
  functionWorkflow(
    "inspect_native_api",
    providerEffects(toolEffects({ mutatesSession: true, idempotent: false }), {
      ...providerRemoteEffects,
      changesUiState: true,
    }),
    "Inspect recovered parameter/return boundary types and jump-table dispatch for one native function selected by symbol or address. Returns confidence, supporting Evidence, case/data/target mappings, unsupported facets and residual unknowns. Null case values are unresolved, never known defaults. Use analyze_function for the broader function dossier.",
  ),
  functionWorkflow(
    "reconstruct_procedure_hardware_interactions",
    providerNetworkEvidenceEffects,
    "Reconstruct MMIO and peripheral register interactions from outgoing procedure_references for one native firmware procedure. Resolves architectural memory regions, optional SoC/board catalogs (or esp_chip_id / uf2_family_id container hints), and optional caller-supplied CMSIS-SVD XML or parsed Devicetree maps while preserving Evidence provenance, register aliases, ambiguous controller windows, unsettled board facts, and limitations.",
  ),
] as const satisfies readonly ToolContract[];
