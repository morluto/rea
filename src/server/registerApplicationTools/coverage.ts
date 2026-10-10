import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";

import { evaluateReconstructionCoverage } from "../../application/ReconstructionCoverageService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("evaluate_reconstruction_coverage");

/** Register the inline fail-closed reconstruction coverage evaluator. */
export const registerCoverageTools = (
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
            () => Promise.resolve(evaluateReconstructionCoverage(input)),
          );
          return server.delivery.toCallToolResult(result, contract);
        },
      ),
  );
};
