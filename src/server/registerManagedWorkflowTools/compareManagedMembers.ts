import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { compareManagedMembersEvidenceValidated } from "../../application/managed/ManagedMemberComparisonService.js";
import { managedMemberComparisonResultSchema } from "../../domain/managed/managedMemberComparison.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { managedWorkflowContract } from "./contract.js";
import { resolveManagedEvidence } from "./evidence.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const compareContract = managedWorkflowContract("compare_managed_members");

/** Register the managed member comparison workflow tool. */
export const registerCompareManagedMembers = (
  server: EvidenceMcpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    compareContract.name,
    toolRegistrationOptions(compareContract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        compareContract.name,
        context.mcpReq.signal,
        async () => {
          const leftResolved = resolveManagedEvidence(input.left);
          const rightResolved = resolveManagedEvidence(input.right);
          if (!leftResolved.ok)
            return server.delivery.toCallToolResult(
              leftResolved,
              compareContract,
            );
          if (!rightResolved.ok)
            return server.delivery.toCallToolResult(
              rightResolved,
              compareContract,
            );
          const [left] = leftResolved.value;
          const [right] = rightResolved.value;
          if (left === undefined || right === undefined)
            throw new TypeError(
              "Managed comparison Evidence resolution failed",
            );
          const parsed = { left, right };
          const result = await logToolExecution(
            options.logger,
            compareContract.name,
            () =>
              Promise.resolve(compareManagedMembersEvidenceValidated(parsed)),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, compareContract);
          const recorded = recordSessionEvidenceSources(
            options.recordEvidence,
            [parsed.left, parsed.right],
          );
          if (!recorded.ok)
            return server.delivery.toCallToolResult(recorded, compareContract);
          const comparison = managedMemberComparisonResultSchema.parse(
            result.value.normalized_result,
          );
          const unknown = comparison.summary.unknown > 0;
          const output = unknown
            ? options.recordEvidenceWithUnknown?.(result.value, {
                question:
                  "Which managed members remain unmatched or ambiguous across these versions?",
                severity: "medium",
                domain: "managed-member-comparison",
                supporting_evidence_ids: [result.value.evidence_id],
                contradicting_evidence_ids: [],
                required_authority: "shipped-artifact",
                required_confidence: "observed",
                required_environment: null,
                recommended_probes: [
                  {
                    operation: "inspect_managed_members",
                    rationale:
                      "Review the inspection Evidence coverage and limit diagnostics; this operation has no page override, so unresolved members must remain unknown.",
                  },
                ],
                relationships: [],
              })
            : options.recordEvidence?.(result.value);
          return server.delivery.toEvidenceToolResult(
            result.value,
            compareContract,
            output,
          );
        },
      ),
  );
};
