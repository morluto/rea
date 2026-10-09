import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySession.js";
import { toolContract } from "../contracts/toolContracts.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../domain/evidence.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { err } from "../domain/result.js";
import { compareFunctions } from "../domain/functionComparison.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { recordSessionEvidenceSources } from "./sessionEvidence.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { FUNCTION_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register explicit Evidence-backed function comparison. */
export const registerFunctionComparisonTool = (
  server: EvidenceMcpServer,
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
        return server.delivery.toCallToolResult(
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
        return server.delivery.toCallToolResult(
          err(new EvidenceIntegrityError("Expected analyze_function Evidence")),
          contract,
        );
      const leftIds = [leftEvidence.evidence_id];
      const rightIds = [rightEvidence.evidence_id];
      const computed = await runDerivedOperation(context, contract.name, () =>
        compareFunctions(leftEvidence, rightEvidence),
      );
      if (!computed.ok)
        return server.delivery.toCallToolResult(computed, contract);
      const comparison = computed.value;
      const recordedSources = recordSessionEvidenceSources(
        (evidence) => session.recordEvidence(evidence),
        [leftEvidence, rightEvidence],
      );
      if (!recordedSources.ok)
        return server.delivery.toCallToolResult(recordedSources, contract);
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
          comparisonEvidenceId: evidence.evidence_id,
        }),
      );
      return server.delivery.toEvidenceToolResult(evidence, contract, recorded);
    },
  );
};

const functionUnknownInput = ({
  status,
  leftIds,
  rightIds,
  comparisonEvidenceId,
}: {
  status: ReturnType<typeof compareFunctions>["status"];
  leftIds: readonly string[];
  rightIds: readonly string[];
  comparisonEvidenceId: string;
}): RecordUnknownInput | undefined => {
  if (status === "unchanged") return undefined;
  const supportingIds = [...new Set([...leftIds, ...rightIds])];
  const contradictingIds = rightIds.filter((id) => !leftIds.includes(id));
  const contradictory = status === "changed";
  return {
    question: `Function comparison is ${status} (comparison ${comparisonEvidenceId})`,
    severity: status === "changed" ? "medium" : "high",
    domain: "function-comparison",
    supporting_evidence_ids: contradictory ? [...leftIds] : supportingIds,
    contradicting_evidence_ids: contradictory ? contradictingIds : [],
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
