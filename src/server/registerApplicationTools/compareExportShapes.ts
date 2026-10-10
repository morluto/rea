import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { resolvePairedEvidenceRequest } from "../../application/EvidenceInputResolver.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { compareJavaScriptExportShapesEvidenceValidated } from "../../application/javascript/JavaScriptApplicationWorkflowService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { javaScriptExportShapeComparisonResultSchema } from "../../domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("compare_javascript_export_shapes");

/** Register the execution-free exact JavaScript export-shape comparison. */
export const registerCompareJavaScriptExportShapesTool = (
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
          const resolved = resolvePairedEvidenceRequest(
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
                compareJavaScriptExportShapesEvidenceValidated(parsed),
              ),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          const recorded = recordSessionEvidenceSources(
            options.recordEvidence,
            [parsed.left, parsed.right],
          );
          if (!recorded.ok)
            return server.delivery.toCallToolResult(recorded, contract);
          const comparison = javaScriptExportShapeComparisonResultSchema.parse(
            result.value.normalized_result,
          );
          const unknown =
            comparison.summary.unknown > 0 ||
            comparison.coverage.status !== "complete-within-inputs";
          return recordResult(
            { ...options, delivery: server.delivery },
            contract,
            result.value,
            unknown ? "javascript-export-shape" : undefined,
          );
        },
      ),
  );
};
