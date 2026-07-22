import type { McpServer } from "@modelcontextprotocol/server";

import {
  executeNodeCharacterization,
  prepareNodeCharacterization,
} from "../../application/NodeRuntimeCharacterizationService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import {
  nodeCharacterizationExecutionInputSchema,
  nodeCharacterizationExecutionOutputSchema,
  nodeCharacterizationPreparationInputSchema,
  nodeCharacterizationPreparationOutputSchema,
} from "../../domain/nodeRuntimeCharacterization.js";
import { parseEvidence } from "../../domain/evidence.js";
import { logToolExecution } from "../toolLogging.js";
import { toCallToolResult } from "../toolResult.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { mcpProgressReporter } from "../mcpProgress.js";
import { recordSources } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const prepareContract = applicationToolContract(
  "prepare_node_characterization",
);
const executeContract = applicationToolContract(
  "execute_node_characterization",
);

/** Register node runtime characterization prepare and execute tools. */
export const registerCharacterizationTools = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    prepareContract.name,
    toolRegistrationOptions(prepareContract),
    async (input, context) => {
      const parsed = safeParseToolInput(
        nodeCharacterizationPreparationInputSchema,
        input,
        prepareContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, prepareContract);
      const result = await logToolExecution(
        options.logger,
        prepareContract.name,
        () =>
          prepareNodeCharacterization(options.replay, parsed.value, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, prepareContract);
      const output = nodeCharacterizationPreparationOutputSchema.parse(
        result.value,
      );
      const recorded = options.recordEvidence?.(
        parseEvidence(output.transformation_evidence),
      );
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, prepareContract);
      return toCallToolResult(result, prepareContract, {
        evidenceResourcesAvailable: options.recordEvidence !== undefined,
      });
    },
  );
  server.registerTool(
    executeContract.name,
    toolRegistrationOptions(executeContract),
    async (input, context) => {
      const parsed = safeParseToolInput(
        nodeCharacterizationExecutionInputSchema,
        input,
        executeContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, executeContract);
      const result = await logToolExecution(
        options.logger,
        executeContract.name,
        () =>
          executeNodeCharacterization(options.replay, parsed.value, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, executeContract);
      const output = nodeCharacterizationExecutionOutputSchema.parse(
        result.value,
      );
      const sources = [
        output.transformation_evidence,
        ...output.replay.source_evidence,
        ...(output.replay.evidence === null ? [] : [output.replay.evidence]),
        output.evidence,
      ].map((item) => parseEvidence(item));
      const recorded = recordSources(options.recordEvidence, sources);
      if (!recorded.ok) return toCallToolResult(recorded, executeContract);
      return toCallToolResult(result, executeContract, {
        evidenceResourcesAvailable: options.recordEvidence !== undefined,
      });
    },
  );
};
