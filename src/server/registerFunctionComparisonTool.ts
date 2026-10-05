import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { toolContract } from "../contracts/toolContracts.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../domain/evidence.js";
import { EvidenceIntegrityError } from "../domain/errors.js";
import { err } from "../domain/result.js";
import { compareFunctions } from "../domain/functionComparison.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { recordSessionEvidenceSources } from "./sessionEvidence.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { FUNCTION_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Register explicit Evidence-backed function comparison. */
export const registerFunctionComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"compare_functions">>,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      let leftEvidence: Evidence;
      let rightEvidence: Evidence;
      try {
        leftEvidence = parseEvidence(input.left);
        rightEvidence = parseEvidence(input.right);
      } catch (cause: unknown) {
        return toCallToolResult(
          err(
            new EvidenceIntegrityError(
              cause instanceof Error ? cause.message : "Invalid Evidence",
            ),
          ),
          contract,
        );
      }
      if (
        leftEvidence.operation !== "analyze_function" ||
        rightEvidence.operation !== "analyze_function" ||
        leftEvidence.predicate_type !== "rea.analysis" ||
        rightEvidence.predicate_type !== "rea.analysis"
      )
        return toCallToolResult(
          err(new EvidenceIntegrityError("Expected analyze_function Evidence")),
          contract,
        );
      const leftIds = [leftEvidence.evidence_id];
      const rightIds = [rightEvidence.evidence_id];
      const computed = await runDerivedOperation(context, contract.name, () =>
        compareFunctions(leftEvidence, rightEvidence),
      );
      if (!computed.ok) return toCallToolResult(computed, contract);
      const comparison = computed.value;
      const recordedSources = recordSessionEvidenceSources(
        (evidence) => session.recordEvidence(evidence),
        [leftEvidence, rightEvidence],
      );
      if (!recordedSources.ok)
        return toCallToolResult(recordedSources, contract);
      const evidence = createEvidence(undefined, FUNCTION_COMPARISON_PROVIDER, {
        predicateType: "rea.function-comparison",
        operation: contract.name,
        parameters: {
          left_evidence_id: leftEvidence.evidence_id,
          right_evidence_id: rightEvidence.evidence_id,
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
  status,
  leftIds,
  rightIds,
}: {
  status: ReturnType<typeof compareFunctions>["status"];
  leftIds: readonly string[];
  rightIds: readonly string[];
}): RecordUnknownInput | undefined => {
  if (status === "unchanged") return undefined;
  return {
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
          "Capture complete dossiers for both functions under the same target context.",
      },
    ],
    relationships: [],
  };
};
