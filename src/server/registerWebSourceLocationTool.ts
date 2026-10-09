import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { WebSourceLocationService } from "../application/WebSourceLocationService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind source point tracing to its exact named contract and session Evidence owner. */
export const registerWebSourceLocationTool = (
  server: EvidenceMcpServer,
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
      if (!result.ok) return server.delivery.toCallToolResult(result, contract);
      const recorded = recordEvidence?.(result.value);
      return server.delivery.toEvidenceToolResult(
        result.value,
        contract,
        recorded,
      );
    },
  );
};
