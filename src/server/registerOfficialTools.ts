import type { McpServer } from "@modelcontextprotocol/server";

import type { HopperToolPort } from "../application/HopperToolPort.js";
import {
  OFFICIAL_TOOL_CONTRACTS,
  type ToolContract,
} from "../contracts/toolContracts.js";
import { jsonValueSchema, type JsonValue } from "../hopper/protocol.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";

/** Register direct bridge proxies, preserving MCP cancellation and typed errors. */
export const registerOfficialTools = (
  server: McpServer,
  hopper: HopperToolPort,
  logger: Logger,
): void => {
  for (const contract of OFFICIAL_TOOL_CONTRACTS) {
    registerOfficialTool(server, hopper, contract, logger);
  }
};

const registerOfficialTool = (
  server: McpServer,
  hopper: HopperToolPort,
  contract: ToolContract,
  logger: Logger,
): void => {
  server.registerTool(
    contract.name,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      annotations: contract.annotations,
    },
    async (input, context) => {
      const arguments_ = projectOfficialArguments(contract, input);
      const result = await logToolExecution(logger, contract.name, () =>
        hopper.callTool(contract.name, arguments_, {
          signal: context.mcpReq.signal,
        }),
      );
      return toCallToolResult(result, contract);
    },
  );
};

const projectOfficialArguments = (
  contract: ToolContract,
  input: unknown,
): Readonly<Record<string, JsonValue>> => {
  const parsed = jsonValueSchema.safeParse(input);
  if (
    !parsed.success ||
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    // The SDK validates this with the same schema before invoking the callback.
    throw new Error("Validated MCP tool input was not a JSON object");
  }

  const projected: Record<string, JsonValue> = {};
  for (const key of Object.keys(contract.inputSchema.shape)) {
    projected[key] = parsed.data[key] ?? null;
  }
  return projected;
};
