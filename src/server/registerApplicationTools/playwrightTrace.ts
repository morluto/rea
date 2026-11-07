import { PlaywrightTraceDecoder } from "../../browser/history/playwrightTrace/PlaywrightTraceDecoder.js";
import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { requireAnalysisViewRetention } from "../../application/analysisView/AnalysisViewService.js";
import { PlaywrightTraceService } from "../../application/playwrightTrace/PlaywrightTraceService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { logToolExecution } from "../toolLogging.js";
import { deliverApplicationEvidence } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = toolContract("inspect_playwright_trace");

/** Reads use the server's existing artifact resource owner and Evidence session. */
export const registerPlaywrightTraceTool = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  const service = new PlaywrightTraceService(
    new PlaywrightTraceDecoder(options.artifactResources),
  );
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
            () => service.inspect(input, context.mcpReq.signal),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          return deliverApplicationEvidence(
            server,
            options,
            contract,
            { evidence: result.value, sources: [] },
            input.view ??
              (input.detail === "summary" ? { kind: "summary" } : undefined),
            context.mcpReq.signal,
          );
        },
      ),
  );
};
