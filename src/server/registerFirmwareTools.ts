import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { FirmwareAnalysisService } from "../application/FirmwareAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { FirmwareOperation } from "../domain/firmwareAnalysis.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Bind firmware handlers to their exact named schemas. */
export const registerFirmwareTools = (
  server: McpServer,
  service: FirmwareAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const handler =
    (contract: ToolContract<FirmwareOperation>) =>
    async (input: unknown, context: ServerContext) => {
      const result = await logToolExecution(logger, contract.name, () =>
        service.execute(contract.name, input, {
          signal: context.mcpReq.signal,
        }),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordEvidence?.(result.value);
      return recorded !== undefined && !recorded.ok
        ? toCallToolResult(recorded, contract)
        : toCallToolResult(result, contract);
    };
  const inspect = toolContract("inspect_firmware_regions");
  server.registerTool(
    inspect.name,
    toolRegistrationOptions(inspect),
    handler(inspect),
  );
  const extract = toolContract("extract_firmware");
  server.registerTool(
    extract.name,
    toolRegistrationOptions(extract),
    handler(extract),
  );
};
