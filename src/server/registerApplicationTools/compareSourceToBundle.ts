import type { McpServer } from "@modelcontextprotocol/server";

import { resolveCompareSourceToBundleRequestValidated } from "../../application/ApplicationWorkflowEvidenceResolver.js";
import { compareSourceToBundleEvidenceValidated } from "../../application/JavaScriptApplicationWorkflowService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { sourceToBundleComparisonResultSchema } from "../../domain/sourceToBundleComparisonSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
import { recordResult, recordSources } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("compare_source_to_bundle");

/** Register conservative historical-source to bundle comparison. */
export const registerCompareSourceToBundleTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const resolved = resolveCompareSourceToBundleRequestValidated(
        input,
        options.evidenceLookup,
      );
      if (!resolved.ok) return toCallToolResult(resolved, contract);
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(compareSourceToBundleEvidenceValidated(resolved.value)),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordSources(options.recordEvidence, [
        resolved.value.application,
      ]);
      if (!recorded.ok) return toCallToolResult(recorded, contract);
      const comparison = sourceToBundleComparisonResultSchema.parse(
        result.value.normalized_result,
      );
      return recordResult(
        options,
        contract,
        result.value,
        resolved.value.unknown_registry_approved === true &&
          comparison.summary.unknown > 0
          ? "source-to-bundle-comparison"
          : undefined,
      );
    },
  );
};
