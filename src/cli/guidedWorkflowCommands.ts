import type { Logger } from "pino";

import { GUIDED_WORKFLOWS_TOOL_CONTRACT } from "../contracts/guidedWorkflowToolContract.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { registerContractCommand } from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Register provider-free listing and rendering of existing guided prompts. */
export const registerGuidedWorkflowCommands = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    GUIDED_WORKFLOWS_TOOL_CONTRACT,
    {
      description: "List or render REA's existing guided workflows",
      runtimeJson: {
        arguments:
          "--arguments-json must contain a valid JSON object of string values.",
      },
      fields: {
        action: {
          default: "list",
          description: "List available workflows or render one",
        },
        workflow_id: {
          description: "Guided workflow identifier for --action render",
        },
        arguments: {
          name: "argumentsJson",
          description:
            "JSON object containing caller-supplied string arguments",
        },
      },
    },
    async (input) => {
      const { accessGuidedWorkflows } =
        await import("../application/GuidedWorkflowAccess.js");
      const result = accessGuidedWorkflows(input, {
        listRemediation:
          "Run `rea guided-workflows` to list workflow identifiers and their argument requirements.",
      });
      return result.ok ? result.value : projectAnalysisError(result.error);
    },
  );
