import type { McpServer } from "@modelcontextprotocol/server";

import { runControlledReplayValidated } from "../../application/JavaScriptReplayService.js";
import { APPLICATION_TOOL_CONTRACTS } from "../../contracts/applicationToolContracts.js";
import {
  controlledReplayInputSchema,
  controlledReplayOutputSchema,
} from "../../domain/javascriptReplay.js";
import { parseEvidence } from "../../domain/evidence.js";
import { logToolExecution } from "../toolLogging.js";
import { toCallToolResult } from "../toolResult.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { mcpProgressReporter } from "../mcpProgress.js";
import { recordSources } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const replayContract = APPLICATION_TOOL_CONTRACTS[2];

/** Register the controlled JavaScript replay tool. */
export const registerControlledReplayTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    replayContract.name,
    toolRegistrationOptions(replayContract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        controlledReplayInputSchema,
        input,
        replayContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, replayContract);
      const parsed = parsedInput.value;
      const result = await logToolExecution(
        options.logger,
        replayContract.name,
        () =>
          runControlledReplayValidated(options.replay, parsed, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, replayContract);
      const output = controlledReplayOutputSchema.parse(result.value);
      if (output.evidence !== null) {
        const sourcesRecorded = recordSources(
          options.recordEvidence,
          output.source_evidence.map((item) => parseEvidence(item)),
        );
        if (!sourcesRecorded.ok)
          return toCallToolResult(sourcesRecorded, replayContract);
        const recorded = options.recordEvidence?.(
          parseEvidence(output.evidence),
        );
        if (recorded !== undefined && !recorded.ok)
          return toCallToolResult(recorded, replayContract);
      }
      return toCallToolResult(result, replayContract, {
        evidenceResourcesAvailable:
          output.evidence !== null && options.recordEvidence !== undefined,
      });
    },
  );
};
