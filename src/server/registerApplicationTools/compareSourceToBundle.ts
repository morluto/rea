import { requireAnalysisViewRetention } from "../../application/analysisView/AnalysisViewService.js";
import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";

import { executeSourceToBundleComparison } from "../../application/javascript/JavaScriptApplicationWorkflowService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { deliverApplicationEvidence } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = toolContract("compare_source_to_bundle");

/** Register conservative historical-source to bundle comparison. */
export const registerCompareSourceToBundleTool = (
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
          if (input.view !== undefined) {
            const retention = requireAnalysisViewRetention(
              contract.name,
              options,
            );
            if (!retention.ok)
              return server.delivery.toCallToolResult(retention, contract);
          }
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              executeSourceToBundleComparison(
                input,
                contract.inputSchema,
                options.evidenceById,
                options.artifactResources,
                { signal: context.mcpReq.signal },
              ),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          return deliverApplicationEvidence(
            server,
            options,
            contract,
            result.value,
            input.view,
            context.mcpReq.signal,
            result.value.result.summary.unknown > 0
              ? "source-to-bundle-comparison"
              : undefined,
          );
        },
      ),
  );
};
