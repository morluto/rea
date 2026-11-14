import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { inspectEvtxArchiveEvidence } from "../../application/evtxArchive/EvtxArchiveService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { logToolExecution } from "../toolLogging.js";
import { deliverApplicationEvidence } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = toolContract("inspect_evtx_archive");

/** Reads use the server's existing artifact resource owner and Evidence session. */
export const registerEvtxArchiveTool = (
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
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              inspectEvtxArchiveEvidence(input, options.artifactResources, {
                signal: context.mcpReq.signal,
              }),
          );
          if (!result.ok)
            return server.delivery.toPartialErrorToolResult(
              result.error,
              contract.returnsTargetContent,
              options.recordEvidence,
            );
          // A cancellation after the read and inventory completes must not discard
          // the observed log; the completed Evidence carries that file snapshot.
          return deliverApplicationEvidence(
            server,
            options,
            contract,
            { evidence: result.value.evidence, sources: [] },
            undefined,
            context.mcpReq.signal,
          );
        },
      ),
  );
};
