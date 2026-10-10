import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { compareArtifacts } from "../domain/artifactComparison.js";
import { createEvidence, parseEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "../application/InvestigationProviders.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

/** Register Evidence-backed deterministic artifact comparison. */
export const registerArtifactComparisonTool = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"compare_artifacts">>,
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
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () => {
              const left = parseEvidence(input.left);
              const right = parseEvidence(input.right);
              return { left, right, comparison: compareArtifacts(left, right) };
            },
          );
          if (!computed.ok)
            return server.delivery.toCallToolResult(computed, contract);
          const { left, right, comparison } = computed.value;
          const sources = [left, right];
          for (const source of sources) {
            const recordedSource = session.recordEvidence(source);
            if (!recordedSource.ok)
              return server.delivery.toCallToolResult(recordedSource, contract);
          }
          const leftEvidenceIds = [left.evidence_id];
          const rightEvidenceIds = [right.evidence_id];
          const evidence = createEvidence(
            undefined,
            ARTIFACT_COMPARISON_PROVIDER,
            {
              predicateType: "rea.artifact-comparison",
              operation: contract.name,
              parameters: {
                left_evidence_ids: leftEvidenceIds,
                right_evidence_ids: rightEvidenceIds,
              },
              result: jsonValueSchema.parse(comparison),
              confidence: "derived",
              authority: "analyst-inference",
              limitations: comparison.limitations,
              evidenceLinks: [...leftEvidenceIds, ...rightEvidenceIds],
            },
          );
          return server.delivery.toEvidenceToolResult(
            evidence,
            contract,
            recordDerivedEvidence(
              session,
              evidence,
              artifactUnknownInput(
                left,
                right,
                comparison.status,
                evidence.evidence_id,
              ),
            ),
          );
        },
      ),
  );
};

const artifactUnknownInput = (
  left: { readonly evidence_id: string },
  right: { readonly evidence_id: string },
  status: ReturnType<typeof compareArtifacts>["status"],
  comparisonEvidenceId: string,
): RecordUnknownInput | undefined => {
  if (status === "unchanged") return undefined;
  const contradictory =
    (status === "changed" || status === "contradiction") &&
    left.evidence_id !== right.evidence_id;
  return {
    question: `Artifact comparison is ${status} (comparison ${comparisonEvidenceId})`,
    severity:
      status === "unknown" || status === "truncated" ? "high" : "medium",
    domain: "artifact-comparison",
    supporting_evidence_ids: contradictory
      ? [left.evidence_id]
      : [...new Set([left.evidence_id, right.evidence_id])],
    contradicting_evidence_ids: contradictory ? [right.evidence_id] : [],
    required_authority: "shipped-artifact",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [
      {
        operation: "inspect_artifact",
        rationale: "Inspect both artifacts and compare their complete graphs.",
      },
    ],
    relationships: [],
  };
};
