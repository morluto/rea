import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { inspectWarcArchiveEvidence } from "../../application/warcArchive/WarcArchiveService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { logToolExecution } from "../toolLogging.js";
import { deliverApplicationEvidence } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = toolContract("inspect_warc_archive");

/** Reads use the server's existing artifact resource owner and Evidence session. */
export const registerWarcArchiveTool = (
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
              inspectWarcArchiveEvidence(input, options.artifactResources, {
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
          // the observed archive; the completed Evidence carries that file snapshot.
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
