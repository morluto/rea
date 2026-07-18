import type { McpServer } from "@modelcontextprotocol/server";

import { compareManagedMembersEvidenceValidated } from "../../application/ManagedMemberComparisonService.js";
import { compareManagedMembersReferenceInputSchema } from "../../contracts/managedWorkflowToolContracts.js";
import { managedMemberComparisonResultSchema } from "../../domain/managedMemberComparison.js";
import { logToolExecution } from "../toolLogging.js";
import { toCallToolResult } from "../toolResult.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { managedWorkflowContract } from "./contract.js";
import { recordManagedSources, resolveManagedEvidence } from "./evidence.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const compareContract = managedWorkflowContract("compare_managed_members");

/** Register the managed member comparison workflow tool. */
export const registerCompareManagedMembers = (
  server: McpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    compareContract.name,
    toolRegistrationOptions(compareContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        compareManagedMembersReferenceInputSchema,
        input,
        compareContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, compareContract);
      const resolved = resolveManagedEvidence(options.session, [
        parsedInput.value.left_evidence_id,
        parsedInput.value.right_evidence_id,
      ]);
      if (!resolved.ok) return toCallToolResult(resolved, compareContract);
      const [left, right] = resolved.value;
      if (left === undefined || right === undefined)
        throw new TypeError("Managed comparison Evidence resolution failed");
      const {
        left_evidence_id: _leftEvidenceId,
        right_evidence_id: _rightEvidenceId,
        ...referencedInput
      } = parsedInput.value;
      const parsed = { ...referencedInput, left, right };
      const result = await logToolExecution(
        options.logger,
        compareContract.name,
        () => Promise.resolve(compareManagedMembersEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, compareContract);
      const recorded = recordManagedSources(options.recordEvidence, [
        parsed.left,
        parsed.right,
      ]);
      if (!recorded.ok) return toCallToolResult(recorded, compareContract);
      const comparison = managedMemberComparisonResultSchema.parse(
        result.value.normalized_result,
      );
      const unknown = comparison.summary.unknown > 0;
      const output =
        parsed.unknown_registry_approved === true && unknown
          ? options.recordEvidenceWithUnknown?.(result.value, {
              approved: true,
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
                    "Repeat static member inspection with complete pages and method bodies.",
                },
              ],
              relationships: [],
            })
          : options.recordEvidence?.(result.value);
      if (output !== undefined && !output.ok)
        return toCallToolResult(output, compareContract);
      return toCallToolResult(
        { ok: true, value: result.value },
        compareContract,
        {
          evidenceResourcesAvailable: output !== undefined,
        },
      );
    },
  );
};
