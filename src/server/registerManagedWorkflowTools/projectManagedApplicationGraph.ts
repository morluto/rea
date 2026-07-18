import type { McpServer } from "@modelcontextprotocol/server";

import { projectManagedApplicationGraphEvidence } from "../../application/ManagedApplicationGraphService.js";
import { managedApplicationGraphReferenceInputSchema } from "../../contracts/managedWorkflowToolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toCallToolResult } from "../toolResult.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { managedWorkflowContract } from "./contract.js";
import {
  recordManagedSources,
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
      const parsedInput = safeParseToolInput(
        managedApplicationGraphReferenceInputSchema,
        input,
        graphContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, graphContract);
      const managedArtifact =
        parsedInput.value.managed_artifact_evidence_id === undefined
          ? undefined
          : resolveManagedArtifactEvidence(
              options.session,
              parsedInput.value.managed_artifact_evidence_id,
            );
      if (managedArtifact !== undefined && !managedArtifact.ok)
        return toCallToolResult(managedArtifact, graphContract);
      const managedMembers =
        parsedInput.value.managed_members_evidence_id === undefined
          ? undefined
          : resolveManagedEvidence(options.session, [
              parsedInput.value.managed_members_evidence_id,
            ]);
      if (managedMembers !== undefined && !managedMembers.ok)
        return toCallToolResult(managedMembers, graphContract);
      const managedBoundaries =
        parsedInput.value.managed_native_boundaries_evidence_id === undefined
          ? undefined
          : resolveManagedBoundaryEvidence(
              options.session,
              parsedInput.value.managed_native_boundaries_evidence_id,
            );
      if (managedBoundaries !== undefined && !managedBoundaries.ok)
        return toCallToolResult(managedBoundaries, graphContract);
      const parsed = {
        limits: parsedInput.value.limits,
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
      const recordedSources = recordManagedSources(
        options.recordEvidence,
        sourceEvidence(parsed),
      );
      if (!recordedSources.ok)
        return toCallToolResult(recordedSources, graphContract);
      const recorded = options.recordEvidence?.(result.value);
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, graphContract);
      return toCallToolResult(result, graphContract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
    },
  );
};
