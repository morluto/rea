import type { McpServer } from "@modelcontextprotocol/server";

import { compareApplicationVersionsEvidenceValidated } from "../../application/JavaScriptApplicationWorkflowService.js";
import { APPLICATION_TOOL_CONTRACTS } from "../../contracts/applicationToolContracts.js";
import { compareApplicationVersionsInputSchema } from "../../domain/javascriptApplicationVersionComparisonSchemas.js";
import { applicationVersionComparisonResultSchema } from "../../domain/javascriptApplicationVersionComparisonSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toCallToolResult } from "../toolResult.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { recordResult, recordSources } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const compareContract = APPLICATION_TOOL_CONTRACTS[1];

/** Register the provider-neutral JavaScript version comparison tool. */
export const registerCompareApplicationVersionsTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    compareContract.name,
    toolRegistrationOptions(compareContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        compareApplicationVersionsInputSchema,
        input,
        compareContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, compareContract);
      const parsed = parsedInput.value;
      const result = await logToolExecution(
        options.logger,
        compareContract.name,
        () =>
          Promise.resolve(compareApplicationVersionsEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, compareContract);
      const sources = [
        parsed.left,
        parsed.right,
        ...parsed.left_native_observations,
        ...parsed.right_native_observations,
      ];
      const recorded = recordSources(options.recordEvidence, sources);
      if (!recorded.ok) return toCallToolResult(recorded, compareContract);
      const comparison = applicationVersionComparisonResultSchema.parse(
        result.value.normalized_result,
      );
      const unknown = comparison.summary.unknown > 0;
      return recordResult(
        options,
        compareContract,
        result.value,
        parsed.unknown_registry_approved === true && unknown,
      );
    },
  );
};
