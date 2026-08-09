import type { McpServer } from "@modelcontextprotocol/server";

import { runControlledReplayValidated } from "../../application/JavaScriptReplayService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { parseEvidence } from "../../domain/evidence.js";
import { controlledReplayOutputSchema } from "../../domain/javascriptReplay.js";
import { mcpProgressReporter } from "../mcpProgress.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
import { recordSources } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const replayContract = applicationToolContract("run_controlled_replay");

/** Register the controlled JavaScript replay tool. */
export const registerControlledReplayTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    replayContract.name,
    toolRegistrationOptions(replayContract),
    async (input, context) => {
      const result = await logToolExecution(
        options.logger,
        replayContract.name,
        () =>
          runControlledReplayValidated(options.replay, input, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, replayContract);
      const output = controlledReplayOutputSchema.parse(result.value);
      if (output.phase === "execute") {
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
          output.phase === "execute" && options.recordEvidence !== undefined,
      });
    },
  );
};
