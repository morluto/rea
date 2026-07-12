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
import type { ProviderIdentity } from "../application/AnalysisProvider.js";
import type { Evidence } from "../domain/evidence.js";

/** Register composed workflows against the same port as direct bridge tools. */
export const registerEnhancedTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  logger: Logger,
  activeTarget?: () => BinaryTarget | undefined,
  provider: ProviderIdentity = {
    id: "unidentified",
    name: "Unidentified provider",
    version: null,
  },
  recordEvidence?: (evidence: Evidence) => void,
): void => {
  const services = new EnhancedTools(analysis);
  for (const contract of ENHANCED_TOOL_CONTRACTS) {
    registerEnhancedTool(server, services, contract, {
      logger,
      activeTarget,
      provider,
      recordEvidence,
    });
  }
};

const registerEnhancedTool = (
  server: McpServer,
  services: EnhancedTools,
  contract: ToolContract,
  registration: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly provider: ProviderIdentity;
    readonly recordEvidence: ((evidence: Evidence) => void) | undefined;
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
      if (result.ok) {
        const evidence = createEvidence(
          registration.activeTarget?.(),
          registration.provider,
          {
            operation: name,
            parameters,
            result: result.value,
            confidence: "derived",
            redactedRawPayload: result.value,
          },
        );
        registration.recordEvidence?.(evidence);
        return toCallToolResult({ ok: true, value: evidence }, contract);
      }
      return toCallToolResult(result, contract);
    },
  );
};
