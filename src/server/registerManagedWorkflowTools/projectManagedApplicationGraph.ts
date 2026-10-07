import { recordSessionEvidenceSources } from "../sessionEvidence.js";
import type { McpServer } from "@modelcontextprotocol/server";

import { projectManagedApplicationGraphEvidence } from "../../application/managed/ManagedApplicationGraphService.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
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
  server: McpServer,
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
        return toCallToolResult(managedArtifact, graphContract);
      const managedMembers =
        input.managed_members === undefined
          ? undefined
          : resolveManagedEvidence(input.managed_members);
      if (managedMembers !== undefined && !managedMembers.ok)
        return toCallToolResult(managedMembers, graphContract);
      const managedBoundaries =
        input.managed_native_boundaries === undefined
          ? undefined
          : resolveManagedBoundaryEvidence(input.managed_native_boundaries);
      if (managedBoundaries !== undefined && !managedBoundaries.ok)
        return toCallToolResult(managedBoundaries, graphContract);
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
      if (!result.ok) return toCallToolResult(result, graphContract);
      const recordedSources = recordSessionEvidenceSources(
        options.recordEvidence,
        sourceEvidence(parsed),
      );
      if (!recordedSources.ok)
        return toCallToolResult(recordedSources, graphContract);
      const recorded = options.recordEvidence?.(result.value);
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, graphContract);
      return toCallToolResult(result, graphContract);
    },
  );
};
