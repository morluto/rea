import { resolvePairedEvidenceRequest } from "../../application/EvidenceInputResolver.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";
import type { McpServer } from "@modelcontextprotocol/server";

import { compareJavaScriptExportShapesEvidenceValidated } from "../../application/javascript/JavaScriptApplicationWorkflowService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { javaScriptExportShapeComparisonResultSchema } from "../../domain/javascriptExportShapeComparisonSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("compare_javascript_export_shapes");

/** Register the execution-free exact JavaScript export-shape comparison. */
export const registerCompareJavaScriptExportShapesTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const resolved = resolvePairedEvidenceRequest(
        input,
        options.evidenceById,
      );
      if (!resolved.ok) return toCallToolResult(resolved, contract);
      const parsed = resolved.value;
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(compareJavaScriptExportShapesEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordSessionEvidenceSources(options.recordEvidence, [
        parsed.left,
        parsed.right,
      ]);
      if (!recorded.ok) return toCallToolResult(recorded, contract);
      const comparison = javaScriptExportShapeComparisonResultSchema.parse(
        result.value.normalized_result,
      );
      const unknown = comparison.summary.unknown > 0;
      return recordResult(
        options,
        contract,
        result.value,
        unknown ? "javascript-export-shape" : undefined,
      );
    },
  );
};
