import type { McpServer } from "@modelcontextprotocol/server";

import { importManagedReconstructionEvidenceValidated } from "../../application/ManagedReconstructionService.js";
import { managedReconstructionReferenceInputSchema } from "../../contracts/managedWorkflowToolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toCallToolResult } from "../toolResult.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { managedWorkflowContract } from "./contract.js";
import { resolveManagedEvidence } from "./evidence.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const reconstructionContract = managedWorkflowContract(
  "import_managed_reconstruction",
);

/** Register the managed reconstruction import workflow tool. */
export const registerImportManagedReconstruction = (
  server: McpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    reconstructionContract.name,
    toolRegistrationOptions(reconstructionContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        managedReconstructionReferenceInputSchema,
        input,
        reconstructionContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, reconstructionContract);
      const resolved = resolveManagedEvidence(options.session, [
        parsedInput.value.static_members_evidence_id,
      ]);
      if (!resolved.ok)
        return toCallToolResult(resolved, reconstructionContract);
      const staticMembers = resolved.value[0];
      if (staticMembers === undefined)
        throw new TypeError(
          "Managed reconstruction Evidence resolution failed",
        );
      const {
        static_members_evidence_id: _staticMembersEvidenceId,
        ...referencedInput
      } = parsedInput.value;
      const parsed = { ...referencedInput, static_members: staticMembers };
      const result = await logToolExecution(
        options.logger,
        reconstructionContract.name,
        () =>
          Promise.resolve(importManagedReconstructionEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, reconstructionContract);
      const recordedSource = options.recordEvidence?.(parsed.static_members);
      if (recordedSource !== undefined && !recordedSource.ok)
        return toCallToolResult(recordedSource, reconstructionContract);
      const recorded = options.recordEvidence?.(result.value);
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, reconstructionContract);
      return toCallToolResult(result, reconstructionContract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
    },
  );
};
