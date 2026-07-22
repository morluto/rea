import type { McpServer } from "@modelcontextprotocol/server";

import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import {
  replayMachineRunInputSchema,
  runReplayMachine,
} from "../domain/replayMachineRun.js";
import { ok } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

const contract = SESSION_TOOL_CONTRACTS.find(
  ({ name }) => name === "run_replay_machine",
);
if (contract === undefined)
  throw new TypeError("Missing run_replay_machine tool contract");

/** Register direct execution-free finite replay-machine evaluation. */
export const registerReplayMachineTool = (
  server: McpServer,
  logger: Logger,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const parsed = safeParseToolInput(
        replayMachineRunInputSchema,
        input,
        contract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, contract);
      const result = await logToolExecution(logger, contract.name, () =>
        Promise.resolve(ok(runReplayMachine(parsed.value))),
      );
      return toCallToolResult(result, contract);
    },
  );
};
