import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { requireAnalysisViewRetention } from "../../application/analysisView/AnalysisViewService.js";

import { traceApplicationFeatureEvidence } from "../../application/javascript/JavaScriptApplicationWorkflowService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { deliverApplicationEvidence } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const traceContract = toolContract("trace_application_feature");

/** Register the provider-neutral JavaScript feature trace tool. */
export const registerTraceFeatureTool = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    traceContract.name,
    toolRegistrationOptions(traceContract),
    async ({ view, ...input }, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        traceContract.name,
        context.mcpReq.signal,
        async () => {
          // A selected view is meaningful only when the complete trace can be retained.
          if (view !== undefined) {
            const retention = requireAnalysisViewRetention(
              traceContract.name,
              options,
            );
            if (!retention.ok)
              return server.delivery.toCallToolResult(retention, traceContract);
          }
          const result = await logToolExecution(
            options.logger,
            traceContract.name,
            () =>
              Promise.resolve(
                traceApplicationFeatureEvidence(input, options.evidenceById, {
                  signal: context.mcpReq.signal,
                }),
              ),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, traceContract);
          return deliverApplicationEvidence(
            server,
            options,
            traceContract,
            result.value,
            view,
            context.mcpReq.signal,
          );
        },
      ),
  );
};
