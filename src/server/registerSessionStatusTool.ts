import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { toCallToolResult } from "./toolResult.js";

/** Register the read-only provider and target status operation. */
export const registerSessionStatusTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: (typeof SESSION_TOOL_CONTRACTS)[2],
): void => {
  server.registerTool(
    contract.name,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      annotations: contract.annotations,
    },
    () => toCallToolResult({ ok: true, value: session.status() }, contract),
  );
};
