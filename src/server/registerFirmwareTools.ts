import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ServerContext } from "@modelcontextprotocol/server";
import type { FirmwareAnalysisService } from "../application/firmware/FirmwareAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { FirmwareOperation } from "../domain/firmware/firmwareAnalysis.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind firmware handlers to their exact named schemas. */
export const registerFirmwareTools = (
  server: EvidenceMcpServer,
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
      if (!result.ok) return server.delivery.toCallToolResult(result, contract);
      const recorded = recordEvidence?.(result.value);
      return server.delivery.toEvidenceToolResult(
        result.value,
        contract,
        recorded,
      );
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
