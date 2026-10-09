import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind optional recovery to its exact named contract without acquiring an engine. */
export const registerJavaScriptRecoveryTool = (
  server: EvidenceMcpServer,
  service: JavaScriptRecoveryService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const contract = toolContract("recover_javascript_sources");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await logToolExecution(logger, contract.name, () =>
        service.recover(input, { signal: context.mcpReq.signal }),
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
