import type { McpServer } from "@modelcontextprotocol/server";
import type { WebSourceLocationService } from "../application/WebSourceLocationService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Bind source point tracing to its exact named contract and session Evidence owner. */
export const registerWebSourceLocationTool = (
  server: McpServer,
  service: WebSourceLocationService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const contract = toolContract("trace_web_source_location");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await logToolExecution(logger, contract.name, () =>
        service.trace(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordEvidence?.(result.value);
      return recorded !== undefined && !recorded.ok
        ? toCallToolResult(recorded, contract)
        : toCallToolResult(result, contract);
    },
  );
};
