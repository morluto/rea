import type { McpServer } from "@modelcontextprotocol/server";

import { resolveTraceJavaScriptSemanticsRequestValidated } from "../../application/ApplicationWorkflowEvidenceResolver.js";
import { traceJavaScriptSemanticsEvidenceValidated } from "../../application/JavaScriptSemanticTraceService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { traceJavaScriptSemanticsRequestSchema } from "../../contracts/applicationWorkflowInputContracts.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
import { recordResult, recordSources } from "./helpers.js";
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
      const parsedInput = safeParseToolInput(
        traceJavaScriptSemanticsRequestSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const resolved = resolveTraceJavaScriptSemanticsRequestValidated(
        parsedInput.value,
        options.evidenceLookup,
      );
      if (!resolved.ok) return toCallToolResult(resolved, contract);
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(
          traceJavaScriptSemanticsEvidenceValidated(resolved.value),
        ),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordSources(options.recordEvidence, [
        resolved.value.application,
      ]);
      if (!recorded.ok) return toCallToolResult(recorded, contract);
      return recordResult(options, contract, result.value);
    },
  );
};
