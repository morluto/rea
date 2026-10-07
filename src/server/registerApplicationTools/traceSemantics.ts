import { resolveApplicationEvidenceRequest } from "../../application/EvidenceInputResolver.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";
import type { McpServer } from "@modelcontextprotocol/server";

import { traceJavaScriptSemanticsEvidenceValidated } from "../../application/javascript/JavaScriptSemanticTraceService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("trace_javascript_semantics");

/** Register the bounded JavaScript semantic relation trace tool. */
export const registerTraceJavaScriptSemanticsTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const resolved = resolveApplicationEvidenceRequest(
        input,
        options.evidenceById,
      );
      if (!resolved.ok) return toCallToolResult(resolved, contract);
      const parsed = resolved.value;
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(traceJavaScriptSemanticsEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordSessionEvidenceSources(options.recordEvidence, [
        parsed.application,
      ]);
      if (!recorded.ok) return toCallToolResult(recorded, contract);
      return recordResult(options, contract, result.value);
    },
  );
};
