import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/binary/BinarySession.js";
import { toolContract } from "../contracts/toolContracts.js";
import { compareArtifacts } from "../domain/artifactComparison.js";
import { createEvidence, parseEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult, toEvidenceToolResult } from "./toolResult.js";

/** Register Evidence-backed deterministic artifact comparison. */
export const registerArtifactComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"compare_artifacts">>,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const computed = await runDerivedOperation(context, contract.name, () => {
        const left = parseEvidence(input.left);
        const right = parseEvidence(input.right);
        return { left, right, comparison: compareArtifacts(left, right) };
      });
      if (!computed.ok) return toCallToolResult(computed, contract);
      const { left, right, comparison } = computed.value;
      const sources = [left, right];
      for (const source of sources) {
        const recordedSource = session.recordEvidence(source);
        if (!recordedSource.ok)
          return toCallToolResult(recordedSource, contract);
      }
      const leftEvidenceIds = [left.evidence_id];
      const rightEvidenceIds = [right.evidence_id];
      const evidence = createEvidence(undefined, ARTIFACT_COMPARISON_PROVIDER, {
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
      });
      return toEvidenceToolResult(
        evidence,
        contract,
        recordDerivedEvidence(
          session,
          evidence,
          artifactUnknownInput(left, right, comparison.status),
        ),
      );
    },
  );
};

const artifactUnknownInput = (
  left: { readonly evidence_id: string },
  right: { readonly evidence_id: string },
  status: ReturnType<typeof compareArtifacts>["status"],
): RecordUnknownInput | undefined => {
  if (status === "unchanged" || left.evidence_id === right.evidence_id)
    return undefined;
  return {
    question: `Artifact comparison is ${status}`,
    severity:
      status === "unknown" || status === "truncated" ? "high" : "medium",
    domain: "artifact-comparison",
    supporting_evidence_ids: [left.evidence_id],
    contradicting_evidence_ids: [right.evidence_id],
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
