import { inspectNtfsJournalEvidence } from "../../application/ntfs/NtfsJournalService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { logToolExecution } from "../toolLogging.js";
import { deliverApplicationEvidence } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = toolContract("inspect_ntfs_journal");

export const registerNtfsJournalTool = (
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
          const signal = context.mcpReq.signal;
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              inspectNtfsJournalEvidence(
                input,
                options.artifactResources,
                signal,
              ),
          );
          if (!result.ok)
            return server.delivery.toPartialErrorToolResult(
              result.error,
              contract.returnsTargetContent,
              options.recordEvidence,
            );
          return deliverApplicationEvidence(
            server,
            options,
            contract,
            { evidence: result.value, sources: [] },
            undefined,
            signal,
          );
        },
      ),
  );
};
