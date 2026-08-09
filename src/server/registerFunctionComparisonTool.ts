import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { createEvidence } from "../domain/evidence.js";
import { compareFunctions } from "../domain/functionComparison.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { resolveSessionEvidenceIds } from "./sessionEvidence.js";
import { FUNCTION_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Register explicit Evidence-backed function comparison. */
export const registerFunctionComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: (typeof SESSION_TOOL_CONTRACTS)[8],
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const expected = {
        operation: "analyze_function",
        predicate: "rea.analysis/v2",
      };
      const left = resolveSessionEvidenceIds(
        session,
        input.left_evidence_ids,
        expected,
      );
      if (!left.ok) return toCallToolResult(left, contract);
      const right = resolveSessionEvidenceIds(
        session,
        input.right_evidence_ids,
        expected,
      );
      if (!right.ok) return toCallToolResult(right, contract);
      const leftIds = left.value.map(({ evidence_id: id }) => id);
      const rightIds = right.value.map(({ evidence_id: id }) => id);
      const computed = await runDerivedOperation(context, contract.name, () =>
        compareFunctions(left.value, right.value, input.offset, input.limit),
      );
      if (!computed.ok) return toCallToolResult(computed, contract);
      const comparison = computed.value;
      const evidence = createEvidence(undefined, FUNCTION_COMPARISON_PROVIDER, {
        predicateType: "rea.function-comparison/v1",
        operation: contract.name,
        parameters: {
          left_evidence_ids: leftIds,
          right_evidence_ids: rightIds,
          offset: input.offset,
          limit: input.limit,
        },
        result: jsonValueSchema.parse(comparison),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: comparison.limitations,
        evidenceLinks: [...leftIds, ...rightIds],
      });
      const recorded = recordDerivedEvidence(
        session,
        evidence,
        functionUnknownInput({
          approved: input.unknown_registry_approved,
          status: comparison.status,
          leftIds,
          rightIds,
        }),
      );
      return toCallToolResult(recorded, contract);
    },
  );
};

const functionUnknownInput = ({
  approved,
  status,
  leftIds,
  rightIds,
}: {
  approved: true | undefined;
  status: ReturnType<typeof compareFunctions>["status"];
  leftIds: readonly string[];
  rightIds: readonly string[];
}): RecordUnknownInput | undefined => {
  if (approved !== true || status === "unchanged") return undefined;
  return {
    approved: true,
    question: `Function comparison is ${status}`,
    severity: status === "changed" ? "medium" : "high",
    domain: "function-comparison",
    supporting_evidence_ids: [...leftIds],
    contradicting_evidence_ids: [...rightIds],
    required_authority: "shipped-artifact",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [
      {
        operation: "analyze_function",
        rationale:
          "Capture complete dossiers for both functions under the same target context and analysis limits.",
      },
    ],
    relationships: [],
  };
};
