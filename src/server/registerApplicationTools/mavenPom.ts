import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { inspectMavenPomEvidence } from "../../application/mavenPom/MavenPomService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { logToolExecution } from "../toolLogging.js";
import { deliverApplicationEvidence, recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = toolContract("inspect_maven_pom");

/** Reads use the server's existing artifact resource owner and Evidence session. */
export const registerMavenPomTool = (
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
              inspectMavenPomEvidence(input, options.artifactResources, {
                signal: context.mcpReq.signal,
              }),
          );
          if (!result.ok)
            return server.delivery.toPartialErrorToolResult(
              result.error,
              contract.returnsTargetContent,
              options.recordEvidence,
            );
          // A cancellation that arrives after the read and inventory completes
          // must not discard the observed POM, so the completed result is
          // recorded and returned without another cancellation wait.
          return recordResult(
            { ...options, delivery: server.delivery },
            contract,
            result.value.evidence,
          );
        },
      ),
  );
};
