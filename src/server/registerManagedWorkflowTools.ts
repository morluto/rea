import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { compareManagedMembersEvidence } from "../application/ManagedMemberComparisonService.js";
import { importManagedReconstructionEvidence } from "../application/ManagedReconstructionService.js";
import {
  planManagedRuntimeCorrelationEvidence,
  type ManagedRuntimeCorrelationDependencies,
} from "../application/ManagedRuntimeCorrelationService.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../contracts/managedWorkflowToolContracts.js";
import {
  compareManagedMembersInputSchema,
  managedMemberComparisonResultSchema,
} from "../domain/managedMemberComparison.js";
import { managedReconstructionImportInputSchema } from "../domain/managedReconstruction.js";
import { managedRuntimeCorrelationInputSchema } from "../domain/managedRuntimeCorrelation.js";
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
  readonly runtime: ManagedRuntimeCorrelationDependencies;
}

/** Register provider-neutral managed-code workflows. */
export const registerManagedWorkflowTools = (
  server: McpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  const compareContract = contract("compare_managed_members");
  const reconstructionContract = contract("import_managed_reconstruction");
  const runtimeContract = contract("plan_managed_runtime_correlation");
  server.registerTool(
    compareContract.name,
    toolRegistrationOptions(compareContract),
    async (input) => {
      const parsed = compareManagedMembersInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        compareContract.name,
        () => Promise.resolve(compareManagedMembersEvidence(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, compareContract);
      const recorded = recordSources(options.recordEvidence, [
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
  server.registerTool(
    reconstructionContract.name,
    toolRegistrationOptions(reconstructionContract),
    async (input) => {
      const parsed = managedReconstructionImportInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        reconstructionContract.name,
        () => Promise.resolve(importManagedReconstructionEvidence(parsed)),
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
  server.registerTool(
    runtimeContract.name,
    toolRegistrationOptions(runtimeContract),
    async (input) => {
      const parsed = managedRuntimeCorrelationInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        runtimeContract.name,
        () => planManagedRuntimeCorrelationEvidence(options.runtime, parsed),
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

const contract = (
  name: (typeof MANAGED_WORKFLOW_TOOL_CONTRACTS)[number]["name"],
) => {
  const found = MANAGED_WORKFLOW_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`Missing ${name} contract`);
  return found;
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
