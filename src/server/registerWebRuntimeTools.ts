import type { McpServer } from "@modelcontextprotocol/server";
import type { WebRuntimeService } from "../application/WebRuntimeService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult, toEvidenceToolResult } from "./toolResult.js";

/** Bind distinct runtime operations to named contracts and the session's Evidence owner. */
export const registerWebRuntimeTools = (
  server: McpServer,
  service: WebRuntimeService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const execution = toolContract("observe_web_execution");
  const listeners = toolContract("inspect_web_event_listeners");
  server.registerTool(
    execution.name,
    toolRegistrationOptions(execution),
    async (input, context) => {
      const result = await logToolExecution(logger, execution.name, () =>
        service.observe(input, {
          signal: context.mcpReq.signal,
          progress: mcpProgressReporter(context),
        }),
      );
      if (!result.ok) return toCallToolResult(result, execution);
      const recorded = recordEvidence?.(result.value);
      return toEvidenceToolResult(result.value, execution, recorded);
    },
  );
  server.registerTool(
    listeners.name,
    toolRegistrationOptions(listeners),
    async (input, context) => {
      const result = await logToolExecution(logger, listeners.name, () =>
        service.inspect(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return toCallToolResult(result, listeners);
      const recorded = recordEvidence?.(result.value);
      return toEvidenceToolResult(result.value, listeners, recorded);
    },
  );
};
