import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import {
  artifactComparisonInputSchema,
  compareArtifacts,
} from "../domain/artifactComparison.js";
import { createEvidence } from "../domain/evidence.js";
import { EvidenceIntegrityError } from "../domain/errors.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { err } from "../domain/result.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";

/** Register Evidence-backed deterministic artifact comparison. */
export const registerArtifactComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"compare_artifacts">,
): void => {
  server.registerTool(
    contract.name,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      annotations: contract.annotations,
    },
    (input) => {
      const parsed = artifactComparisonInputSchema.parse(input);
      const comparison = compareArtifacts(
        parsed.left,
        parsed.right,
        parsed.offset,
        parsed.limit,
      );
      const leftEvidenceIds = evidenceIds(parsed.left);
      const rightEvidenceIds = evidenceIds(parsed.right);
      if (
        [...leftEvidenceIds, ...rightEvidenceIds].some(
          (evidenceId) => !session.hasEvidence(evidenceId),
        )
      )
        return toCallToolResult(
          err(
            new EvidenceIntegrityError(
              "Artifact comparison input Evidence is not present in this session",
            ),
          ),
          contract,
        );
      const evidence = createEvidence(undefined, ARTIFACT_COMPARISON_PROVIDER, {
        predicateType: "rea.artifact-comparison/v1",
        operation: contract.name,
        parameters: {
          left_evidence_ids: leftEvidenceIds,
          right_evidence_ids: rightEvidenceIds,
          offset: parsed.offset,
          limit: parsed.limit,
        },
        result: jsonValueSchema.parse(comparison),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: comparison.limitations,
        evidenceLinks: [...leftEvidenceIds, ...rightEvidenceIds],
      });
      return toCallToolResult(
        recordDerivedEvidence(
          session,
          evidence,
          artifactUnknownInput(parsed, comparison.status),
        ),
        contract,
      );
    },
  );
};

const artifactUnknownInput = (
  input: {
    readonly left:
      | { readonly evidence_id: string }
      | readonly { readonly evidence_id: string }[];
    readonly right:
      | { readonly evidence_id: string }
      | readonly { readonly evidence_id: string }[];
    readonly unknown_registry_approved?: true | undefined;
  },
  status: ReturnType<typeof compareArtifacts>["status"],
): RecordUnknownInput | undefined => {
  if (input.unknown_registry_approved !== true || status === "unchanged")
    return undefined;
  return {
    approved: true,
    question: `Artifact comparison is ${status}`,
    severity:
      status === "unknown" || status === "truncated" ? "high" : "medium",
    domain: "artifact-comparison",
    supporting_evidence_ids: evidenceIds(input.left),
    contradicting_evidence_ids: evidenceIds(input.right),
    required_authority: "shipped-artifact",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [
      {
        operation: "inventory_artifact",
        rationale: "Capture both complete artifact graphs under equal limits.",
      },
    ],
    relationships: [],
  };
};

const evidenceIds = (
  input:
    | { readonly evidence_id: string }
    | readonly { readonly evidence_id: string }[],
): string[] =>
  (Array.isArray(input) ? input : [input]).map(({ evidence_id: id }) => id);
