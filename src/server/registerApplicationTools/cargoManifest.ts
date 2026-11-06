import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { inspectCargoManifestEvidence } from "../../application/cargoManifest/CargoManifestService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { logToolExecution } from "../toolLogging.js";
import { deliverApplicationEvidence } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = toolContract("inspect_cargo_manifest");

/** Reads use the server's existing artifact resource owner and Evidence session. */
export const registerCargoManifestTool = (
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
              inspectCargoManifestEvidence(input, options.artifactResources, {
                signal: context.mcpReq.signal,
              }),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          return deliverApplicationEvidence(
            server,
            options,
            contract,
            { evidence: result.value, sources: [] },
            undefined,
            context.mcpReq.signal,
          );
        },
      ),
  );
};
