import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { requireAnalysisViewRetention } from "../../application/analysisView/AnalysisViewService.js";
import { compareStaticAndObservedEndpointsEvidence } from "../../application/javascript/StaticObservedEndpointComparisonService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { logToolExecution } from "../toolLogging.js";
import { deliverApplicationEvidence } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = toolContract("compare_static_and_observed_endpoints");

/** Both adapters execute the same authenticated, provider-free comparison. */
export const registerCompareEndpointsTool = (
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
          if (input.detail === "summary" || input.view !== undefined) {
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
              compareStaticAndObservedEndpointsEvidence(
                input,
                options.evidenceById,
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
            input.view ??
              (input.detail === "summary" ? { kind: "summary" } : undefined),
            context.mcpReq.signal,
          );
        },
      ),
  );
};
