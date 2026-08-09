import type { McpServer } from "@modelcontextprotocol/server";

import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { runReplayMachine } from "../domain/replayMachineRun.js";
import { ok } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

const contract = SESSION_TOOL_CONTRACTS[18];

/** Register direct execution-free finite replay-machine evaluation. */
export const registerReplayMachineTool = (
  server: McpServer,
  logger: Logger,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const result = await logToolExecution(logger, contract.name, () =>
        Promise.resolve(ok(runReplayMachine(input))),
      );
      return toCallToolResult(result, contract);
    },
  );
};
