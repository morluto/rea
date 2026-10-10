import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { PeResourcesService } from "../application/binaryDiagnostics/PeResourcesService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file PE resource workflow and retain its complete Evidence. */
export const registerPeResourcesTool = (
  server: EvidenceMcpServer,
  service: PeResourcesService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const contract = toolContract("inspect_pe_resources");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await logToolExecution(logger, contract.name, () =>
        service.inspect(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return server.delivery.toCallToolResult(result, contract);
      return server.delivery.toEvidenceToolResult(
        result.value,
        contract,
        recordEvidence?.(result.value),
      );
    },
  );
};
