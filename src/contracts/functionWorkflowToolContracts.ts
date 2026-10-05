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
) => {
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
  } satisfies ToolContract<Name, typeof inputSchema, typeof outputSchema>;
};

/** Function dossier and native API reconstruction workflow contracts. */
export const FUNCTION_WORKFLOW_TOOL_CONTRACTS = [
  functionWorkflow(
    "analyze_function",
    "Build a dossier for one native function identified by symbol or provider-returned address. Returns identity with complete inclusive body ranges or explicit unknown, provider-specific pseudocode and assembly, comments, calls, references, referenced strings/names, local CFG blocks, and available native API boundary observations.",
  ),
  functionWorkflow(
    "inspect_native_api",
    "Analyze a native API boundary in one function identified by symbol or provider-returned address. Returns confidence, evidence, jump-table dispatch/data/target mappings, unsupported branches, and residual unknowns.",
  ),
] as const satisfies readonly ToolContract[];
