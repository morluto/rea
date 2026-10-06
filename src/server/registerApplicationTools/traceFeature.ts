import { resolveApplicationEvidenceRequest } from "../../application/EvidenceInputResolver.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";
import type { McpServer } from "@modelcontextprotocol/server";

import { traceApplicationFeatureEvidenceValidated } from "../../application/JavaScriptApplicationWorkflowService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const traceContract = applicationToolContract("trace_application_feature");

/** Register the provider-neutral JavaScript feature trace tool. */
export const registerTraceFeatureTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    traceContract.name,
    toolRegistrationOptions(traceContract),
    async (input) => {
      const resolved = resolveApplicationEvidenceRequest(
        input,
        options.evidenceById,
      );
      if (!resolved.ok) return toCallToolResult(resolved, traceContract);
      const parsed = resolved.value;
      const result = await logToolExecution(
        options.logger,
        traceContract.name,
        () => Promise.resolve(traceApplicationFeatureEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, traceContract);
      const sources = [parsed.application, ...parsed.native_observations];
      const recorded = recordSessionEvidenceSources(
        options.recordEvidence,
        sources,
      );
      if (!recorded.ok) return toCallToolResult(recorded, traceContract);
      return recordResult(options, traceContract, result.value);
    },
  );
};
