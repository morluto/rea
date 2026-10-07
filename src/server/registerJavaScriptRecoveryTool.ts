import type { McpServer } from "@modelcontextprotocol/server";
import type { JavaScriptRecoveryService } from "../application/JavaScriptRecoveryService.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Bind optional recovery to its exact named contract without acquiring an engine. */
export const registerJavaScriptRecoveryTool = (
  server: McpServer,
  service: JavaScriptRecoveryService,
  logger: Logger,
  recordEvidence?: BinarySessionPort["recordEvidence"],
): void => {
  const contract = toolContract("recover_javascript_sources");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await logToolExecution(logger, contract.name, () =>
        service.recover(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordEvidence?.(result.value);
      return recorded !== undefined && !recorded.ok
        ? toCallToolResult(recorded, contract)
        : toCallToolResult(result, contract);
    },
  );
};
