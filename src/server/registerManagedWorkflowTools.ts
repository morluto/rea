import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { compareManagedMembersEvidence } from "../application/ManagedMemberComparisonService.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../contracts/managedWorkflowToolContracts.js";
import {
  compareManagedMembersInputSchema,
  managedMemberComparisonResultSchema,
} from "../domain/managedMemberComparison.js";
import type { Evidence } from "../domain/evidence.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

interface ManagedWorkflowToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | BinarySessionPort["recordEvidenceWithUnknown"]
    | undefined;
}

/** Register provider-neutral managed-code workflows. */
export const registerManagedWorkflowTools = (
  server: McpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  const [contract] = MANAGED_WORKFLOW_TOOL_CONTRACTS;
  if (contract === undefined)
    throw new Error("Missing managed workflow contract");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const parsed = compareManagedMembersInputSchema.parse(input);
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(compareManagedMembersEvidence(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordSources(options.recordEvidence, [
        parsed.left,
        parsed.right,
      ]);
      if (!recorded.ok) return toCallToolResult(recorded, contract);
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
        return toCallToolResult(output, contract);
      return toCallToolResult({ ok: true, value: result.value }, contract, {
        evidenceResourcesAvailable: output !== undefined,
      });
    },
  );
};

const recordSources = (
  recordEvidence: ManagedWorkflowToolRegistration["recordEvidence"],
  sources: readonly Evidence[],
) => {
  for (const source of sources) {
    const recorded = recordEvidence?.(source);
    if (recorded !== undefined && !recorded.ok) return recorded;
  }
  return { ok: true as const, value: null };
};
