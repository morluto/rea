import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import {
  buildReconstructionObligationLedgerEvidenceValidated,
  resolveReconstructionObligationLedgerRequest,
} from "../../application/ReconstructionObligationLedgerService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract(
  "build_reconstruction_obligation_ledger",
);

/** Register conservative reconstruction-obligation generation and closure. */
export const registerReconstructionObligationLedgerTool = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const resolved = resolveReconstructionObligationLedgerRequest(input);
          if (!resolved.ok)
            return server.delivery.toCallToolResult(resolved, contract);
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              Promise.resolve(
                buildReconstructionObligationLedgerEvidenceValidated(
                  resolved.value,
                ),
              ),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          const recorded = recordSessionEvidenceSources(
            options.recordEvidence,
            resolved.value.evidence_bundle.records,
          );
          if (!recorded.ok)
            return server.delivery.toCallToolResult(recorded, contract);
          return recordResult(
            { ...options, delivery: server.delivery },
            contract,
            result.value,
          );
        },
      ),
  );
};
