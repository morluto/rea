import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata, toolEffects } from "./toolEffects.js";
import {
  guidedWorkflowsInputSchema,
  guidedWorkflowsOutputSchema,
} from "./guidedWorkflowSchemas.js";

/** Standalone contract for lazy CLI registration of `guided-workflows`. */
export const GUIDED_WORKFLOWS_TOOL_CONTRACT = {
  name: "guided_workflows",
  cli: true,
  ...toolContractMetadata("guided_workflows", toolEffects()),
  description:
    "List or render REA's existing guided workflows. Rendering returns guidance only; it does not inspect targets, start analysis, or change session state.",
  kind: "application",
  inputSchema: guidedWorkflowsInputSchema,
  outputSchema: guidedWorkflowsOutputSchema,
  examples: [
    {
      title: "List the available guided workflows",
      input: { action: "list" },
    },
    {
      title: "Render feature investigation guidance",
      input: {
        action: "render",
        workflow_id: "investigate_feature",
        arguments: { feature: "offline search" },
      },
    },
  ],
} as const satisfies ToolContract;
