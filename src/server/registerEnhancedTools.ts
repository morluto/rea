import type { McpServer } from "@modelcontextprotocol/server";

import { EnhancedTools } from "../application/EnhancedTools.js";
import type { HopperToolPort } from "../application/HopperToolPort.js";
import { enhancedToolNameSchema } from "../contracts/enhancedInputs.js";
import {
  ENHANCED_TOOL_CONTRACTS,
  type ToolContract,
} from "../contracts/toolContracts.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";

/** Register composed workflows against the same port as direct bridge tools. */
export const registerEnhancedTools = (
  server: McpServer,
  hopper: HopperToolPort,
  logger: Logger,
): void => {
  const services = new EnhancedTools(hopper);
  for (const contract of ENHANCED_TOOL_CONTRACTS) {
    registerEnhancedTool(server, services, contract, logger);
  }
};

const registerEnhancedTool = (
  server: McpServer,
  services: EnhancedTools,
  contract: ToolContract,
  logger: Logger,
): void => {
  const name = enhancedToolNameSchema.parse(contract.name);
  server.registerTool(
    name,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      annotations: contract.annotations,
    },
    async (input, context) =>
      toCallToolResult(
        await logToolExecution(logger, name, () =>
          services.execute(name, input, context.mcpReq.signal),
        ),
        contract,
      ),
  );
};
