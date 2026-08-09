import type { McpServer } from "@modelcontextprotocol/server";

import { resolveCompareJavaScriptExportShapesRequestValidated } from "../../application/ApplicationWorkflowEvidenceResolver.js";
import { compareJavaScriptExportShapesEvidenceValidated } from "../../application/JavaScriptApplicationWorkflowService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { javaScriptExportShapeComparisonResultSchema } from "../../domain/javascriptExportShapeComparisonSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
import { recordResult, recordSources } from "./helpers.js";
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
      const resolved = resolveCompareJavaScriptExportShapesRequestValidated(
        input,
        options.evidenceLookup,
      );
      if (!resolved.ok) return toCallToolResult(resolved, contract);
      const parsed = resolved.value;
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(compareJavaScriptExportShapesEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordSources(options.recordEvidence, [
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
        parsed.unknown_registry_approved === true && unknown
          ? "javascript-export-shape"
          : undefined,
      );
    },
  );
};
