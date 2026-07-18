import type { McpServer } from "@modelcontextprotocol/server";

import { traceApplicationFeatureEvidenceValidated } from "../../application/JavaScriptApplicationWorkflowService.js";
import { APPLICATION_TOOL_CONTRACTS } from "../../contracts/applicationToolContracts.js";
import { traceApplicationFeatureInputSchema } from "../../domain/javascriptFeatureTraceSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toCallToolResult } from "../toolResult.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { recordResult, recordSources } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const traceContract = APPLICATION_TOOL_CONTRACTS[0];

/** Register the provider-neutral JavaScript feature trace tool. */
export const registerTraceFeatureTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    traceContract.name,
    toolRegistrationOptions(traceContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        traceApplicationFeatureInputSchema,
        input,
        traceContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, traceContract);
      const parsed = parsedInput.value;
      const result = await logToolExecution(
        options.logger,
        traceContract.name,
        () => Promise.resolve(traceApplicationFeatureEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, traceContract);
      const sources = [parsed.application, ...parsed.native_observations];
      const recorded = recordSources(options.recordEvidence, sources);
      if (!recorded.ok) return toCallToolResult(recorded, traceContract);
      return recordResult(options, traceContract, result.value);
    },
  );
};
