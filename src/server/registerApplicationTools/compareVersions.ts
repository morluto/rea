import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { resolvePairedEvidenceRequest } from "../../application/EvidenceInputResolver.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { compareApplicationVersionsEvidenceValidated } from "../../application/javascript/JavaScriptApplicationWorkflowService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { applicationVersionComparisonResultSchema } from "../../domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const compareContract = applicationToolContract("compare_application_versions");

/** Register the provider-neutral JavaScript version comparison tool. */
export const registerCompareApplicationVersionsTool = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    compareContract.name,
    toolRegistrationOptions(compareContract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        compareContract.name,
        context.mcpReq.signal,
        async () => {
          const resolved = resolvePairedEvidenceRequest(
            input,
            options.evidenceById,
          );
          if (!resolved.ok)
            return server.delivery.toCallToolResult(resolved, compareContract);
          const parsed = resolved.value;
          const result = await logToolExecution(
            options.logger,
            compareContract.name,
            () =>
              Promise.resolve(
                compareApplicationVersionsEvidenceValidated(parsed),
              ),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, compareContract);
          const sources = [
            parsed.left,
            parsed.right,
            ...parsed.left_native_observations,
            ...parsed.right_native_observations,
          ];
          const recorded = recordSessionEvidenceSources(
            options.recordEvidence,
            sources,
          );
          if (!recorded.ok)
            return server.delivery.toCallToolResult(recorded, compareContract);
          const comparison = applicationVersionComparisonResultSchema.parse(
            result.value.normalized_result,
          );
          const unknown = comparison.summary.unknown > 0;
          return recordResult(
            { ...options, delivery: server.delivery },
            compareContract,
            result.value,
            unknown ? "application-version-comparison" : undefined,
          );
        },
      ),
  );
};
