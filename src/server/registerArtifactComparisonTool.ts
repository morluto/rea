import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import {
  artifactComparisonInputSchema,
  compareArtifacts,
} from "../domain/artifactComparison.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { resolveSessionEvidenceIds } from "./sessionEvidence.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { safeParseToolInput } from "./toolInputValidation.js";

/** Register Evidence-backed deterministic artifact comparison. */
export const registerArtifactComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"compare_artifacts">,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        artifactComparisonInputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const parsed = parsedInput.value;
      const expected = {
        operation: "inventory_artifact",
        predicate: "rea.analysis/v2",
      };
      const left = resolveSessionEvidenceIds(
        session,
        parsed.left_evidence_ids,
        expected,
      );
      if (!left.ok) return toCallToolResult(left, contract);
      const right = resolveSessionEvidenceIds(
        session,
        parsed.right_evidence_ids,
        expected,
      );
      if (!right.ok) return toCallToolResult(right, contract);
      const computed = await runDerivedOperation(context, contract.name, () =>
        compareArtifacts(left.value, right.value, parsed.offset, parsed.limit),
      );
      if (!computed.ok) return toCallToolResult(computed, contract);
      const comparison = computed.value;
      const leftEvidenceIds = parsed.left_evidence_ids;
      const rightEvidenceIds = parsed.right_evidence_ids;
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
    readonly left_evidence_ids: readonly string[];
    readonly right_evidence_ids: readonly string[];
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
    supporting_evidence_ids: [...input.left_evidence_ids],
    contradicting_evidence_ids: [...input.right_evidence_ids],
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
