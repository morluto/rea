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
  providerRemoteEffects,
  providerUiNetworkEvidenceEffects,
  toolEffects,
} from "./toolEffects.js";
import { enhancedOutputSchemas } from "./toolOutputSchemaGroups.js";

type FunctionWorkflowName =
  | "analyze_function"
  | "inspect_native_api"
  | "inspect_procedure_hardware_instructions";

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
  inspect_procedure_hardware_instructions:
    enhancedInputSchemas.inspect_procedure_hardware_instructions,
} as const;

/** The contracts below that the CLI exposes as commands. */
const FUNCTION_WORKFLOW_CLI_CONTRACTS: ReadonlySet<string> = new Set([
  "inspect_native_api",
  "inspect_procedure_hardware_instructions",
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
    "inspect_procedure_hardware_instructions",
    providerUiNetworkEvidenceEffects,
    "Extract and classify non-MMIO architectural hardware instructions from one disassembled procedure using an explicit hardware_architecture (arm, arm64, riscv, xtensa, mips, x86, or x86_64). Reports system/special registers (MRS/MSR, MCR/MRC, RDMSR/WRMSR, CR0..CR8), RISC-V CSRs (csrr*), Xtensa RSR/WSR/XSR, MIPS CP0, x86 port I/O (in/out), interrupt masks (CPSID/CPSIE, CLI/STI), memory barriers, and privilege/sleep transitions. Register-indirect ports or MSRs (such as DX or ECX) keep target: null with target_basis: unresolved_register.",
  ),
] as const satisfies readonly ToolContract[];
