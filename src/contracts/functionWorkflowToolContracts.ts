import { jsonObjectSchema } from "../domain/jsonValue.js";
import { enhancedInputSchemas } from "./enhancedInputs.js";
import { TOOL_EXAMPLE_OVERRIDES } from "./toolContractExamples.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { enhancedOutputSchemas } from "./toolOutputSchemas.js";
import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";

type FunctionWorkflowName = "analyze_function" | "inspect_native_api";

const functionWorkflow = <Name extends FunctionWorkflowName>(
  name: Name,
  description: string,
): ToolContract<Name> => {
  const inputSchema = enhancedInputSchemas[name];
  const outputSchema = requireOutputSchema(enhancedOutputSchemas, name);
  return {
    name,
    ...toolContractMetadata(name),
    description,
    kind: "enhanced",
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
  };
};

/** Function dossier and native API reconstruction workflow contracts. */
export const FUNCTION_WORKFLOW_TOOL_CONTRACTS = [
  functionWorkflow(
    "analyze_function",
    "Preferred bounded analysis for one procedure symbol or address. Returns identity, provider-specific pseudocode, optional assembly, comments, calls, typed-or-explicitly-unavailable references, referenced strings/names, and local CFG blocks with exact truncation metadata. Providers with a structured decompiler model also expose native API boundary types, confidence, evidence, jump-table data/target addresses, and explicit decompiler-artifact labels.",
  ),
  functionWorkflow(
    "inspect_native_api",
    "Reconstruct one native function boundary through inspectable substeps. Returns structured inferred return/parameter types with confidence and evidence, jump-table dispatch/data/target mappings, explicit decompiler-artifact labels, unsupported branches, and residual unknowns.",
  ),
] as const satisfies readonly ToolContract[];
