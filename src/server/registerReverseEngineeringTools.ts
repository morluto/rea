import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { ReverseEngineeringService } from "../application/reverse/ReverseEngineeringService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

/** Register objdump and Rizin operations against their exact named contracts. */
export const registerReverseEngineeringTools = (
  server: McpServer,
  service: ReverseEngineeringService,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const objdump = toolContract("inspect_with_objdump");
  const rizin = toolContract("execute_rizin_command");
  server.registerTool(
    objdump.name,
    toolRegistrationOptions(objdump),
    async (input, context: ServerContext) => {
      const result = await logToolExecution(logger, objdump.name, () =>
        service.inspectWithObjdump(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return delivery.toCallToolResult(result, objdump);
      return delivery.toEvidenceToolResult(
        result.value,
        objdump,
        recordEvidence?.(result.value),
      );
    },
  );
  server.registerTool(
    rizin.name,
    toolRegistrationOptions(rizin),
    async (input, context: ServerContext) => {
      const result = await logToolExecution(logger, rizin.name, () =>
        service.executeRizinCommand(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return delivery.toCallToolResult(result, rizin);
      return delivery.toEvidenceToolResult(
        result.value,
        rizin,
        recordEvidence?.(result.value),
      );
    },
  );
};
