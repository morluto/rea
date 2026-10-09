import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { projectManagedApplicationGraphEvidence } from "../../application/managed/ManagedApplicationGraphService.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { managedWorkflowContract } from "./contract.js";
import {
  resolveManagedArtifactEvidence,
  resolveManagedBoundaryEvidence,
  resolveManagedEvidence,
  sourceEvidence,
} from "./evidence.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const graphContract = managedWorkflowContract(
  "project_managed_application_graph",
);

/** Register the managed application graph projection workflow tool. */
export const registerProjectManagedApplicationGraph = (
  server: EvidenceMcpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    graphContract.name,
    toolRegistrationOptions(graphContract),
    async (input) => {
      const managedArtifact =
        input.managed_artifact === undefined
          ? undefined
          : resolveManagedArtifactEvidence(input.managed_artifact);
      if (managedArtifact !== undefined && !managedArtifact.ok)
        return server.delivery.toCallToolResult(managedArtifact, graphContract);
      const managedMembers =
        input.managed_members === undefined
          ? undefined
          : resolveManagedEvidence(input.managed_members);
      if (managedMembers !== undefined && !managedMembers.ok)
        return server.delivery.toCallToolResult(managedMembers, graphContract);
      const managedBoundaries =
        input.managed_native_boundaries === undefined
          ? undefined
          : resolveManagedBoundaryEvidence(input.managed_native_boundaries);
      if (managedBoundaries !== undefined && !managedBoundaries.ok)
        return server.delivery.toCallToolResult(
          managedBoundaries,
          graphContract,
        );
      const parsed = {
        managed_artifact: managedArtifact?.value[0],
        managed_members: managedMembers?.value[0],
        managed_native_boundaries: managedBoundaries?.value[0],
      };
      const result = await logToolExecution(
        options.logger,
        graphContract.name,
        () => Promise.resolve(projectManagedApplicationGraphEvidence(parsed)),
      );
      if (!result.ok)
        return server.delivery.toCallToolResult(result, graphContract);
      const recordedSources = recordSessionEvidenceSources(
        options.recordEvidence,
        sourceEvidence(parsed),
      );
      if (!recordedSources.ok)
        return server.delivery.toCallToolResult(recordedSources, graphContract);
      const recorded = options.recordEvidence?.(result.value);
      return server.delivery.toEvidenceToolResult(
        result.value,
        graphContract,
        recorded,
      );
    },
  );
};
