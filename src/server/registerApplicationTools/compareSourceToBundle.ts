import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { resolveApplicationEvidenceRequest } from "../../application/EvidenceInputResolver.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { compareSourceToBundleEvidenceValidated } from "../../application/javascript/JavaScriptApplicationWorkflowService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { sourceToBundleComparisonResultSchema } from "../../domain/javascript/sourceToBundleComparisonSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("compare_source_to_bundle");

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
              Promise.resolve(compareSourceToBundleEvidenceValidated(parsed)),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          const recorded = recordSessionEvidenceSources(
            options.recordEvidence,
            [parsed.application],
          );
          if (!recorded.ok)
            return server.delivery.toCallToolResult(recorded, contract);
          const comparison = sourceToBundleComparisonResultSchema.parse(
            result.value.normalized_result,
          );
          return recordResult(
            { ...options, delivery: server.delivery },
            contract,
            result.value,
            comparison.summary.unknown > 0
              ? "source-to-bundle-comparison"
              : undefined,
          );
        },
      ),
  );
};
