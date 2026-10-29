import { resolvePairedEvidenceRequest } from "../application/EvidenceInputResolver.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { createEvidence } from "../domain/evidence.js";
import { parseFunctionEvidence } from "../domain/functionDossierEvidence.js";
import { FUNCTION_COMPARISON_PROVIDER } from "../domain/comparisonEvidenceIdentity.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { recordEvidenceSources } from "../application/investigation/recordEvidenceSources.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

import { compareFunctions } from "../domain/functionComparison.js";
import { uniqueSorted } from "../domain/canonicalOrdering.js";
/** Register explicit Evidence-backed function comparison. */
export const registerFunctionComparisonTool = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"compare_functions">>,
): void => {
  const admission = withAdmittedAnalysis({ kind: "session", session });
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const resolved = resolvePairedEvidenceRequest(
            input,
            session.evidenceForAnalysis.bind(session),
          );
          if (!resolved.ok)
            return server.delivery.toCallToolResult(resolved, contract);
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () => {
              const left = parseFunctionEvidence(resolved.value.left, {
                operation: contract.name,
                path: ["left"],
              });
              if (!left.ok) throw left.error;
              const right = parseFunctionEvidence(resolved.value.right, {
                operation: contract.name,
                path: ["right"],
              });
              if (!right.ok) throw right.error;
              return {
                left: left.value,
                right: right.value,
                comparison: compareFunctions(left.value, right.value),
              };
            },
          );
          if (!computed.ok)
            return server.delivery.toCallToolResult(computed, contract);
          const { left, right, comparison } = computed.value;
          const leftEvidence = left.evidence;
          const rightEvidence = right.evidence;
          const leftIds = [leftEvidence.evidence_id];
          const rightIds = [rightEvidence.evidence_id];
          const recordedSources = recordEvidenceSources(
            (evidence) => session.recordEvidence(evidence),
            [leftEvidence, rightEvidence],
          );
          if (!recordedSources.ok)
            return server.delivery.toCallToolResult(recordedSources, contract);
          const evidence = createEvidence(
            undefined,
            FUNCTION_COMPARISON_PROVIDER,
            {
              predicateType: "rea.function-comparison",
              operation: contract.name,
              parameters: {
                left_evidence_id: leftEvidence.evidence_id,
                right_evidence_id: rightEvidence.evidence_id,
              },
              result: comparison,
              confidence: "derived",
              authority: "analyst-inference",
              limitations: comparison.limitations,
              evidenceLinks: [...leftIds, ...rightIds],
            },
          );
          const recorded = recordDerivedEvidence(
            session,
            evidence,
            comparisonUnknownInput(
              comparison,
              leftIds,
              rightIds,
              evidence.evidence_id,
            ),
          );
          return server.delivery.toEvidenceToolResult(
            evidence,
            contract,
            recorded,
          );
        },
      ),
  );
};

const comparisonUnknownInput = (
  comparison: ReturnType<typeof compareFunctions>,
  leftIds: readonly string[],
  rightIds: readonly string[],
  comparisonEvidenceId: string,
): RecordUnknownInput | undefined =>
  functionUnknownInput({
    status: comparison.status,
    dimensions: comparison.dimensions
      .filter(({ status }) =>
        comparison.status === "unknown"
          ? status === "unknown"
          : status === "changed",
      )
      .map(({ dimension }) => dimension),
    leftIds,
    rightIds,
    comparisonEvidenceId,
  });

const functionUnknownInput = ({
  status,
  dimensions,
  leftIds,
  rightIds,
  comparisonEvidenceId,
}: {
  status: ReturnType<typeof compareFunctions>["status"];
  dimensions: readonly ReturnType<
    typeof compareFunctions
  >["dimensions"][number]["dimension"][];
  leftIds: readonly string[];
  rightIds: readonly string[];
  comparisonEvidenceId: string;
}): RecordUnknownInput | undefined => {
  if (status === "unchanged") return undefined;
  const supportingIds = [
    ...new Set([...leftIds, ...rightIds, comparisonEvidenceId]),
  ];
  const contradictingIds = rightIds.filter((id) => !leftIds.includes(id));
  const contradictory = status === "changed";
  return {
    question: `Function comparison is ${status} (comparison ${comparisonEvidenceId})`,
    severity: status === "changed" ? "medium" : "high",
    domain: "function-comparison",
    comparison_conclusion_scope: {
      comparison_evidence_id: comparisonEvidenceId,
      dimensions: uniqueSorted([
        ...(status === "unknown" || dimensions.length === 0
          ? ["overall" as const]
          : []),
        ...dimensions,
      ]),
    },
    supporting_evidence_ids: contradictory
      ? [...leftIds, comparisonEvidenceId]
      : supportingIds,
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
