import type { McpServer } from "@modelcontextprotocol/server";

import { EnhancedTools } from "../application/EnhancedTools.js";
import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import { enhancedToolNameSchema } from "../contracts/enhancedInputs.js";
import {
  ENHANCED_TOOL_CONTRACTS,
  type ToolContract,
} from "../contracts/toolContracts.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";

/** Register composed workflows against the same port as direct bridge tools. */
export const registerEnhancedTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  logger: Logger,
  activeTarget?: () => BinaryTarget | undefined,
): void => {
  const services = new EnhancedTools(analysis);
  for (const contract of ENHANCED_TOOL_CONTRACTS) {
    registerEnhancedTool(server, services, contract, { logger, activeTarget });
  }
};

const registerEnhancedTool = (
  server: McpServer,
  services: EnhancedTools,
  contract: ToolContract,
  registration: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  },
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
    async (input, context) => {
      const parsedInput = jsonValueSchema.parse(
        enhancedInputSchemas[name].parse(input),
      );
      if (
        typeof parsedInput !== "object" ||
        parsedInput === null ||
        Array.isArray(parsedInput)
      )
        throw new Error("Validated enhanced input was not a JSON object");
      const parameters: Record<string, JsonValue> = { ...parsedInput };
      const result = await logToolExecution(registration.logger, name, () =>
        services.execute(name, input, context.mcpReq.signal),
      );
      return toCallToolResult(
        result.ok
          ? {
              ok: true,
              value: createEvidence(registration.activeTarget?.(), {
                operation: name,
                parameters,
                result: result.value,
              }),
            }
          : result,
        contract,
      );
    },
  );
};
