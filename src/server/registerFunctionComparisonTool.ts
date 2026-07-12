import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import {
  compareFunctions,
  functionComparisonInputSchema,
} from "../domain/functionComparison.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { EvidenceIntegrityError } from "../domain/errors.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { err } from "../domain/result.js";
import { FUNCTION_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";

/** Register explicit Evidence-backed function comparison. */
export const registerFunctionComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"compare_functions">,
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
      const parsed = functionComparisonInputSchema.parse(input);
      const leftIds = evidenceIds(parsed.left);
      const rightIds = evidenceIds(parsed.right);
      const missing = [...leftIds, ...rightIds].filter(
        (evidenceId) => !session.hasEvidence(evidenceId),
      );
      if (missing.length > 0)
        return toCallToolResult(
          err(
            new EvidenceIntegrityError(
              "Function comparison input Evidence is not present in this session",
            ),
          ),
          contract,
        );
      const comparison = compareFunctions(
        parsed.left,
        parsed.right,
        parsed.offset,
        parsed.limit,
      );
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
          "Capture complete dossiers with equal providers and analysis limits.",
      },
    ],
    relationships: [],
  };
};

const evidenceIds = (input: Evidence | readonly Evidence[]): string[] =>
  (Array.isArray(input) ? input : [input]).map(({ evidence_id: id }) => id);
