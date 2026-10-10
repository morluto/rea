import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { resolveApplicationEvidenceRequest } from "../../application/EvidenceInputResolver.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { traceJavaScriptSemanticsEvidenceValidated } from "../../application/javascript/JavaScriptSemanticTraceService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("trace_javascript_semantics");

/** Register the bounded JavaScript semantic relation trace tool. */
export const registerTraceJavaScriptSemanticsTool = (
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
          const resolved = resolveApplicationEvidenceRequest(
            input,
            options.evidenceById,
          );
          if (!resolved.ok)
            return server.delivery.toCallToolResult(resolved, contract);
          const parsed = resolved.value;
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              Promise.resolve(
                traceJavaScriptSemanticsEvidenceValidated(parsed),
              ),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          const recorded = recordSessionEvidenceSources(
            options.recordEvidence,
            [parsed.application],
          );
          if (!recorded.ok)
            return server.delivery.toCallToolResult(recorded, contract);
          return recordResult(
            { ...options, delivery: server.delivery },
            contract,
            result.value,
          );
        },
      ),
  );
};
