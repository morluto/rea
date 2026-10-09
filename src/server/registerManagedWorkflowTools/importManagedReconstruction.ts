import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";

import { importManagedReconstructionEvidenceValidated } from "../../application/managed/ManagedReconstructionService.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { managedWorkflowContract } from "./contract.js";
import { resolveManagedEvidence } from "./evidence.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const reconstructionContract = managedWorkflowContract(
  "import_managed_reconstruction",
);

/** Register the managed reconstruction import workflow tool. */
export const registerImportManagedReconstruction = (
  server: EvidenceMcpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    reconstructionContract.name,
    toolRegistrationOptions(reconstructionContract),
    async (input) => {
      const resolved = resolveManagedEvidence(input.static_members);
      if (!resolved.ok)
        return server.delivery.toCallToolResult(
          resolved,
          reconstructionContract,
        );
      const staticMembers = resolved.value[0];
      if (staticMembers === undefined)
        throw new TypeError(
          "Managed reconstruction Evidence resolution failed",
        );
      const parsed = { ...input, static_members: staticMembers };
      const result = await logToolExecution(
        options.logger,
        reconstructionContract.name,
        () =>
          Promise.resolve(importManagedReconstructionEvidenceValidated(parsed)),
      );
      if (!result.ok)
        return server.delivery.toCallToolResult(result, reconstructionContract);
      const recordedSource = options.recordEvidence?.(parsed.static_members);
      if (recordedSource !== undefined && !recordedSource.ok)
        return server.delivery.toCallToolResult(
          recordedSource,
          reconstructionContract,
        );
      const recorded = options.recordEvidence?.(result.value);
      return server.delivery.toEvidenceToolResult(
        result.value,
        reconstructionContract,
        recorded,
      );
    },
  );
};
