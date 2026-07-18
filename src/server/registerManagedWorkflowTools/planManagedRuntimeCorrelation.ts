import type { McpServer } from "@modelcontextprotocol/server";

import { planManagedRuntimeCorrelationEvidenceValidated } from "../../application/ManagedRuntimeCorrelationService.js";
import { managedRuntimeCorrelationReferenceInputSchema } from "../../contracts/managedWorkflowToolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toCallToolResult } from "../toolResult.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { managedWorkflowContract } from "./contract.js";
import { resolveManagedEvidence } from "./evidence.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const runtimeContract = managedWorkflowContract(
  "plan_managed_runtime_correlation",
);

/** Register the managed runtime correlation planning workflow tool. */
export const registerPlanManagedRuntimeCorrelation = (
  server: McpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    runtimeContract.name,
    toolRegistrationOptions(runtimeContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        managedRuntimeCorrelationReferenceInputSchema,
        input,
        runtimeContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, runtimeContract);
      const resolved = resolveManagedEvidence(options.session, [
        parsedInput.value.static_members_evidence_id,
      ]);
      if (!resolved.ok) return toCallToolResult(resolved, runtimeContract);
      const staticMembers = resolved.value[0];
      if (staticMembers === undefined)
        throw new TypeError("Managed runtime Evidence resolution failed");
      const {
        static_members_evidence_id: _staticMembersEvidenceId,
        ...referencedInput
      } = parsedInput.value;
      const parsed = { ...referencedInput, static_members: staticMembers };
      const result = await logToolExecution(
        options.logger,
        runtimeContract.name,
        () =>
          Promise.resolve(
            planManagedRuntimeCorrelationEvidenceValidated(
              options.runtime,
              parsed,
            ),
          ),
      );
      if (!result.ok) return toCallToolResult(result, runtimeContract);
      const recordedSource = options.recordEvidence?.(parsed.static_members);
      if (recordedSource !== undefined && !recordedSource.ok)
        return toCallToolResult(recordedSource, runtimeContract);
      const recorded = options.recordEvidence?.(result.value);
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, runtimeContract);
      return toCallToolResult(result, runtimeContract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
    },
  );
};
