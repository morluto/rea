import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import { inspectAnalysisView } from "../application/analysisView/AnalysisViewService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind selected-view projection to its named contract and session Evidence owner. */
export const registerAnalysisViewTool = (
  server: EvidenceMcpServer,
  logger: Logger,
  evidenceById?: EvidenceLookup,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const contract = toolContract("inspect_analysis_view");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const result = await logToolExecution(logger, contract.name, () =>
        Promise.resolve(inspectAnalysisView(input, evidenceById)),
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
