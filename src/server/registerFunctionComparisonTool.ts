import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import {
  compareFunctions,
  functionComparisonInputSchema,
} from "../domain/functionComparison.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { FUNCTION_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { resolveSessionEvidencePair } from "./sessionEvidence.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { safeParseToolInput } from "./toolInputValidation.js";

/** Register explicit Evidence-backed function comparison. */
export const registerFunctionComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"compare_functions">,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        functionComparisonInputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const parsed = parsedInput.value;
      const expected = {
        operation: "analyze_function",
        predicate: "rea.analysis/v2",
      };
      const evidencePair = resolveSessionEvidencePair(
        session,
        {
          left: parsed.left_evidence_ids,
          right: parsed.right_evidence_ids,
        },
        expected,
      );
      if (!evidencePair.ok) return toCallToolResult(evidencePair, contract);
      const leftIds = evidencePair.value.left.map(({ evidence_id: id }) => id);
      const rightIds = evidencePair.value.right.map(
        ({ evidence_id: id }) => id,
      );
      const computed = await runDerivedOperation(context, contract.name, () =>
        compareFunctions(
          evidencePair.value.left,
          evidencePair.value.right,
          parsed.offset,
          parsed.limit,
        ),
      );
      if (!computed.ok) return toCallToolResult(computed, contract);
      const comparison = computed.value;
      const evidence = createEvidence(undefined, FUNCTION_COMPARISON_PROVIDER, {
        predicateType: "rea.function-comparison/v1",
        operation: contract.name,
        parameters: {
          left_evidence_ids: leftIds,
          right_evidence_ids: rightIds,
          offset: parsed.offset,
          limit: parsed.limit,
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
          approved: parsed.unknown_registry_approved,
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
